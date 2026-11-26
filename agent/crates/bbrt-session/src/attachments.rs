//! 用户消息附件（2026-11-26）：路径引用的上下文渲染与视觉通道支持。
//!
//! - [`attachment_lines`] / [`user_text_part`]：附件进模型上下文的单源文本形态；
//! - [`load_image_data_url`]：读盘 → 缩放 → JPEG → base64 data URL（请求体上限
//!   8MiB、原图多张即超，必须缩放后再内联）；
//! - [`ImageCache`]：路径 → data URL 的会话级缓存（用户轮入历史时预载定格——
//!   同一轮每步组装字节一致，模型侧 prompt cache 前缀稳定）；
//! - [`VisionState::user_content`]：带附件用户轮 → 模型消息内容（文本段 + 图像段）。
//!
//! 附件本身只是本机路径引用（协议单行上限 255KB，内联字节走不通）；图像数据
//! 不进 WAL/历史，重启续会话后按路径重新读盘。

use std::collections::HashMap;
use std::io::Cursor;

use base64::Engine;
use bbrt_aigw::{ContentPart, ImageUrl, MessageContent};
use bbrt_context::{AttachmentKind, AttachmentRef};
use image::{DynamicImage, ImageBuffer, Rgb};

/// 单张图片源文件上限（解码前按文件大小拒绝）
pub const MAX_IMAGE_FILE_BYTES: u64 = 20 * 1024 * 1024;
/// 解码像素上限（宽×高；防止超大图解码撑爆 <80MB 空闲内存预算）
pub const MAX_IMAGE_PIXELS: u64 = 16_000_000;
/// 缩放后最长边（主流视觉模型的有效分辨率量级；兼顾请求体大小）
const MAX_EDGE: u32 = 1568;
const JPEG_QUALITY: u8 = 85;
/// 会话内最多缓存的图片张数（FIFO 淘汰最早加载的；每张缩放后约百 KB 级）
const CACHE_CAP: usize = 32;
/// 历史里保留图像数据的带图用户轮数（从最新数起；更早的只留路径清单）
pub(crate) const KEEP_IMAGE_ROUNDS: usize = 3;

/// 仅附件无文字时的文本段占位（模型据此知道用户没写说明）
pub(crate) const ATTACHMENTS_ONLY_NOTE: &str = "(The user sent attachments without a message.)";
/// 模型不支持图片输入时的提示
const UNSUPPORTED_NOTE: &str = "(Image content is not included: the current model does not \
     accept image input. If understanding the image matters, tell the user to switch to a \
     vision-capable model.)";
/// 图片轮滑出保留窗口时的提示
const OMITTED_NOTE: &str =
    "(Image content omitted to save context; the images above are listed by path only.)";

/// 附件清单文本（进模型上下文/子代理任务简报的单源形态）。无附件 → None
pub(crate) fn attachment_lines(attachments: &[AttachmentRef]) -> Option<String> {
    if attachments.is_empty() {
        return None;
    }
    let mut s = String::from("[Attachments]");
    for a in attachments {
        s.push('\n');
        s.push_str(&a.context_line());
    }
    Some(s)
}

/// 带附件用户轮的文本段：原文（空则占位）+ 清单 + 状态提示
pub(crate) fn user_text_part(
    content: &str,
    attachments: &[AttachmentRef],
    note: Option<String>,
) -> String {
    let mut s = if content.trim().is_empty() {
        ATTACHMENTS_ONLY_NOTE.to_string()
    } else {
        content.to_string()
    };
    if let Some(lines) = attachment_lines(attachments) {
        s.push('\n');
        s.push_str(&lines);
    }
    if let Some(n) = note {
        s.push('\n');
        s.push_str(&n);
    }
    s
}

/// 图片加载失败原因（进上下文的占位提示；简短英文——提示词体系已英文化）
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ImageLoadError {
    /// 文件不存在或不是普通文件（被移动/删除）
    NotFound,
    /// 超过源文件大小或像素上限
    TooLarge,
    /// 非图片或解码失败
    Decode,
}

impl std::fmt::Display for ImageLoadError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            ImageLoadError::NotFound => "file not found",
            ImageLoadError::TooLarge => "image too large",
            ImageLoadError::Decode => "not a decodable image",
        })
    }
}

/// 读盘 → 缩放 → JPEG → base64 data URL。
///
/// 透明底铺白（JPEG 无 alpha，不铺会变黑底）；GIF/WebP 动图只取首帧。
pub fn load_image_data_url(path: &str) -> Result<String, ImageLoadError> {
    let meta = std::fs::metadata(path).map_err(|_| ImageLoadError::NotFound)?;
    if !meta.is_file() {
        return Err(ImageLoadError::NotFound);
    }
    if meta.len() > MAX_IMAGE_FILE_BYTES {
        return Err(ImageLoadError::TooLarge);
    }
    let img: DynamicImage = image::open(path).map_err(|_| ImageLoadError::Decode)?;
    let (w, h) = (u64::from(img.width()), u64::from(img.height()));
    if w * h > MAX_IMAGE_PIXELS {
        return Err(ImageLoadError::TooLarge);
    }
    // 最长边超限才缩放（thumbnail 保持宽高比、落在 MAX_EDGE×MAX_EDGE 内；小图不放大）
    let scaled = if w.max(h) > u64::from(MAX_EDGE) {
        img.thumbnail(MAX_EDGE, MAX_EDGE)
    } else {
        img
    };
    let rgb = if scaled.color().has_alpha() {
        composite_on_white(scaled)
    } else {
        scaled.to_rgb8()
    };
    let mut buf = Vec::new();
    {
        // Cursor 绑定局部变量（JpegEncoder 持其可变借用，临时值活不过语句）
        let mut cursor = Cursor::new(&mut buf);
        let encoder = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut cursor, JPEG_QUALITY);
        rgb.write_with_encoder(encoder)
            .map_err(|_| ImageLoadError::Decode)?;
    }
    Ok(format!(
        "data:image/jpeg;base64,{}",
        base64::engine::general_purpose::STANDARD.encode(buf)
    ))
}

/// alpha 通道铺白底合成（c·a + 255·(1−a)）
fn composite_on_white(img: DynamicImage) -> ImageBuffer<Rgb<u8>, Vec<u8>> {
    let rgba = img.to_rgba8();
    let (w, h) = rgba.dimensions();
    let mut out: ImageBuffer<Rgb<u8>, Vec<u8>> = ImageBuffer::new(w, h);
    for (x, y, p) in rgba.enumerate_pixels() {
        let a = u32::from(p[3]);
        let mix = |c: u8| ((u32::from(c) * a + 255 * (255 - a)) / 255) as u8;
        out.put_pixel(x, y, Rgb([mix(p[0]), mix(p[1]), mix(p[2])]));
    }
    out
}

/// 会话级图片缓存：path → data URL。加载失败/非图片也记住（不重复尝试读盘）
#[derive(Debug, Default)]
pub struct ImageCache {
    ok: HashMap<String, String>,
    failed: HashMap<String, ImageLoadError>,
    /// 插入顺序（FIFO 淘汰用）
    order: Vec<String>,
}

impl ImageCache {
    /// 预载一轮附件里的图片（已缓存/已失败/非图片跳过）
    pub fn preload(&mut self, attachments: &[AttachmentRef]) {
        for a in attachments
            .iter()
            .filter(|a| a.kind == AttachmentKind::Image)
        {
            if self.ok.contains_key(&a.path) || self.failed.contains_key(&a.path) {
                continue;
            }
            match load_image_data_url(&a.path) {
                Ok(url) => {
                    if self.order.len() >= CACHE_CAP {
                        let evict = self.order.remove(0);
                        self.ok.remove(&evict);
                    }
                    self.order.push(a.path.clone());
                    self.ok.insert(a.path.clone(), url);
                }
                Err(e) => {
                    self.failed.insert(a.path.clone(), e);
                }
            }
        }
    }

    /// 取缓存的 data URL（未加载/失败/已淘汰 → None）
    pub fn get(&self, path: &str) -> Option<&str> {
        self.ok.get(path).map(String::as_str)
    }

    /// 加载失败原因（未失败 → None）
    fn failure(&self, path: &str) -> Option<ImageLoadError> {
        self.failed.get(path).copied()
    }
}

/// 视觉通道组装状态（一步请求一份；见 `loop_runner::to_chat_messages`）
pub(crate) struct VisionState<'a> {
    /// 会话图片缓存
    pub cache: &'a ImageCache,
    /// 模型不支持图片输入（会话级降级态，切换模型清除）
    pub unsupported: bool,
    /// 本步请求是否携带图像数据（降级重试=false：只发路径清单）
    pub with_images: bool,
}

impl VisionState<'_> {
    /// 带附件用户轮 → 模型消息内容。
    ///
    /// 文本段恒定：原文（空则占位）+ 附件清单 + 状态提示；图像段仅当「模型支持
    /// 视觉 ∧ 本步带图 ∧ 该轮在保留窗口内 ∧ 文件加载成功」时附加。
    /// `rank`=该轮在带图用户轮里从最新数起的序号（无图轮传 `usize::MAX`）。
    pub(crate) fn user_content(
        &self,
        content: &str,
        attachments: &[AttachmentRef],
        rank: usize,
    ) -> MessageContent {
        let has_image = attachments.iter().any(|a| a.kind == AttachmentKind::Image);
        let in_window = rank <= KEEP_IMAGE_ROUNDS;
        let mut images: Vec<String> = Vec::new();
        let mut notes: Vec<String> = Vec::new();
        if has_image {
            if self.unsupported || !self.with_images {
                notes.push(UNSUPPORTED_NOTE.to_string());
            } else if !in_window {
                notes.push(OMITTED_NOTE.to_string());
            }
        }
        if self.with_images && !self.unsupported && in_window {
            for a in attachments
                .iter()
                .filter(|a| a.kind == AttachmentKind::Image)
            {
                match self.cache.get(&a.path) {
                    Some(url) => images.push(url.to_string()),
                    None => {
                        let why = self
                            .cache
                            .failure(&a.path)
                            .map(|e| e.to_string())
                            .unwrap_or_else(|| "not loaded".to_string());
                        notes.push(format!("(Image not available: {} — {why}.)", a.name));
                    }
                }
            }
        }
        let note = (!notes.is_empty()).then(|| notes.join("\n"));
        let text = user_text_part(content, attachments, note);
        if images.is_empty() {
            return MessageContent::Text(text);
        }
        let mut parts = vec![ContentPart::Text { text }];
        for url in images {
            parts.push(ContentPart::ImageUrl {
                image_url: ImageUrl { url },
            });
        }
        MessageContent::Parts(parts)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use bbrt_aigw::ContentPart;
    use image::ImageFormat;

    /// 生成一张纯色 PNG 落到临时目录，返回 (目录, 路径字符串)
    fn write_png(name: &str, w: u32, h: u32) -> (std::path::PathBuf, String) {
        let dir =
            std::env::temp_dir().join(format!("bbc-att-test-{}-{}", std::process::id(), name));
        std::fs::create_dir_all(&dir).unwrap();
        let img: ImageBuffer<Rgb<u8>, Vec<u8>> =
            ImageBuffer::from_fn(w, h, |x, _| Rgb([(x % 256) as u8, 200, 100]));
        let path = dir.join(name);
        img.save_with_format(&path, ImageFormat::Png).unwrap();
        (dir, path.to_str().unwrap().to_string())
    }

    fn image_att(path: &str) -> AttachmentRef {
        AttachmentRef {
            path: path.into(),
            kind: AttachmentKind::Image,
            name: "shot.png".into(),
            size: 1,
            mime: Some("image/png".into()),
        }
    }

    #[test]
    fn 清单渲染_无附件返回空_有附件逐行() {
        assert_eq!(attachment_lines(&[]), None);
        let atts = vec![
            image_att("/a.png"),
            AttachmentRef {
                path: "/b.pdf".into(),
                kind: AttachmentKind::File,
                name: "b.pdf".into(),
                size: 2,
                mime: None,
            },
        ];
        assert_eq!(
            attachment_lines(&atts).unwrap(),
            "[Attachments]\n[Attachment: image] /a.png (shot.png)\n[Attachment: file] /b.pdf (b.pdf)"
        );
    }

    #[test]
    fn 文本段_仅附件用占位_原文非空保留原文() {
        assert_eq!(user_text_part("", &[], None), ATTACHMENTS_ONLY_NOTE);
        assert_eq!(user_text_part("   ", &[], None), ATTACHMENTS_ONLY_NOTE);
        assert_eq!(user_text_part("看图", &[], None), "看图");
        let atts = vec![image_att("/a.png")];
        assert_eq!(
            user_text_part("", &atts, Some("(note)".into())),
            format!("{ATTACHMENTS_ONLY_NOTE}\n[Attachments]\n[Attachment: image] /a.png (shot.png)\n(note)")
        );
    }

    #[test]
    fn 图片加载_缩放到最长边并转jpeg_小图不放大() {
        let (dir, wide) = write_png("wide.png", 3000, 1000);
        let (dir2, small) = write_png("small.png", 64, 32);
        // 3000×1000 → 最长边 1568：1568×523（thumbnail 高度向上取整）
        let url = load_image_data_url(&wide).unwrap();
        assert!(url.starts_with("data:image/jpeg;base64,"), "prefix={url}");
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(url.split_once("base64,").unwrap().1)
            .unwrap();
        let img = image::load_from_memory(&bytes).unwrap();
        assert_eq!((img.width(), img.height()), (1568, 523));
        let url2 = load_image_data_url(&small).unwrap();
        let bytes2 = base64::engine::general_purpose::STANDARD
            .decode(url2.split_once("base64,").unwrap().1)
            .unwrap();
        let img2 = image::load_from_memory(&bytes2).unwrap();
        assert_eq!((img2.width(), img2.height()), (64, 32));
        std::fs::remove_dir_all(&dir).ok();
        std::fs::remove_dir_all(&dir2).ok();
    }

    #[test]
    fn 图片加载_不存在与非图片() {
        assert_eq!(
            load_image_data_url("/nonexistent/bbc-att/none.png"),
            Err(ImageLoadError::NotFound)
        );
        let dir = std::env::temp_dir().join(format!("bbc-att-test-{}-txt", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join("a.png");
        std::fs::write(&p, b"not an image").unwrap();
        assert_eq!(
            load_image_data_url(p.to_str().unwrap()),
            Err(ImageLoadError::Decode)
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn 用户轮内容_无附件原文直出_各降级态提示() {
        let mut cache = ImageCache::default();
        // 无附件：Text 原文（与 v0.1 线上字节一致）
        let atts = vec![image_att("/nonexistent/bbc-att/none.png")];
        // 生产路径先 preload（失败原因入缓存）再渲染
        cache.preload(&atts);
        let v = VisionState {
            cache: &cache,
            unsupported: false,
            with_images: true,
        };
        assert_eq!(
            v.user_content("你好", &[], usize::MAX),
            MessageContent::Text("你好".into())
        );
        match v.user_content("看图", &atts, 1) {
            MessageContent::Text(t) => assert!(
                t.contains("Image not available: shot.png — file not found."),
                "{t}"
            ),
            other => panic!("应为 Text: {other:?}"),
        }
        // 滑出保留窗口：提示省略
        match v.user_content("看图", &atts, KEEP_IMAGE_ROUNDS + 1) {
            MessageContent::Text(t) => assert!(t.contains("Image content omitted"), "{t}"),
            other => panic!("应为 Text: {other:?}"),
        }
        // 模型不支持视觉 / 降级重试：提示切换模型
        let uns = VisionState {
            cache: &cache,
            unsupported: true,
            with_images: true,
        };
        match uns.user_content("看图", &atts, 1) {
            MessageContent::Text(t) => assert!(t.contains("does not accept image input"), "{t}"),
            other => panic!("应为 Text: {other:?}"),
        }
        let retry = VisionState {
            cache: &cache,
            unsupported: false,
            with_images: false,
        };
        match retry.user_content("看图", &atts, 1) {
            MessageContent::Text(t) => assert!(t.contains("does not accept image input"), "{t}"),
            other => panic!("应为 Text: {other:?}"),
        }
    }

    #[test]
    fn 用户轮内容_窗口内带图出图像段_两次渲染字节一致() {
        let (dir, path) = write_png("shot.png", 320, 200);
        let mut cache = ImageCache::default();
        let atts = vec![image_att(&path)];
        cache.preload(&atts);
        assert!(cache.get(&path).is_some());
        let v = VisionState {
            cache: &cache,
            unsupported: false,
            with_images: true,
        };
        let c1 = v.user_content("看图", &atts, 1);
        let c2 = v.user_content("看图", &atts, 1);
        assert_eq!(c1, c2);
        assert_eq!(c1.image_count(), 1);
        let json = serde_json::to_string(&c1).unwrap();
        let json2 = serde_json::to_string(&c2).unwrap();
        assert_eq!(
            json, json2,
            "同一轮两次组装必须逐字节一致（prompt cache 前缀）"
        );
        assert!(json.contains(r#""type":"image_url""#));
        // 文本段仍带清单（模型知道图片原文件路径）
        assert!(c1.text().contains(&path), "{}", c1.text());
        match &c1 {
            MessageContent::Parts(parts) => {
                assert!(matches!(parts[1], ContentPart::ImageUrl { .. }))
            }
            other => panic!("应为 Parts: {other:?}"),
        }
        // 预载幂等
        cache.preload(&atts);
        assert!(cache.get(&path).is_some());
        std::fs::remove_dir_all(&dir).ok();
    }
}
