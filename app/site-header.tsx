'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { FileText, Network, SlidersHorizontal } from 'lucide-react';
import type { ComponentProps } from 'react';

// All in-app links share the same draft protection before client navigation.
export function AppLink(props: ComponentProps<typeof Link>) {
  return (
    <Link
      {...props}
      onNavigate={(event) => {
        if (!window.dispatchEvent(new Event('cg-before-navigate', { cancelable: true })))
          event.preventDefault();
        else props.onNavigate?.(event);
      }}
    />
  );
}
export default function SiteHeader() {
  const pathname = usePathname();
  return (
    <>
      <nav aria-label="快捷跳转" className="cg-skip-nav">
        <a className="cg-skip" href="#main-content">
          跳到主要内容
        </a>
      </nav>
      <header className="site-header">
        <div className="site-header-inner">
          <AppLink href="/" className="site-brand" aria-label="共桌首页">
            <span className="brand-mark" aria-hidden="true">
              <i />
              <i />
              <i />
              <i />
            </span>
            <b>共桌</b>
            <span>COMMON GROUND</span>
          </AppLink>
          <nav aria-label="共桌主导航">
            {(
              [
                ['/', FileText, '文稿工作台'],
                ['/agents', Network, 'AI 协作'],
                ['/connections', SlidersHorizontal, '模型连接'],
              ] as const
            ).map(([href, Icon, label]) => (
              <AppLink key={href} href={href} aria-current={pathname === href ? 'page' : undefined}>
                <Icon size={16} />
                {label}
              </AppLink>
            ))}
          </nav>
          <span className="site-local" title="本机工作空间">
            <i aria-hidden="true" />
            <span className="site-local-full">本机工作空间</span>
            <span className="site-local-short" aria-hidden="true">
              本机
            </span>
          </span>
        </div>
      </header>
    </>
  );
}
