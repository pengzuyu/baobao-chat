/** 设计基元：品牌 Logo（public/logo.svg，导航顶/登录页/关于页复用） */

export function Logo({ size = 28 }: { size?: number }) {
  return <img src="/logo.svg" width={size} height={size} alt="BaobaoWork" />;
}
