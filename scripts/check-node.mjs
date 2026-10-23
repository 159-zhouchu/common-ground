export const minimumNode = '22.9.0';

export function supportedNode(version) {
  const parts = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!parts) return false;
  const current = parts.slice(1).map(Number);
  const minimum = minimumNode.split('.').map(Number);
  for (let i = 0; i < minimum.length; i++) {
    if (current[i] !== minimum[i]) return current[i] > minimum[i];
  }
  return true;
}

export function requireSupportedNode() {
  if (supportedNode(process.versions.node)) return;
  console.error(
    `当前 Node.js 为 ${process.versions.node}，共桌需要 ${minimumNode} 或更高版本。请升级 Node.js 后重新启动；尚未安装依赖或启动服务。`,
  );
  process.exit(1);
}

// Also runs when called directly by the Windows launcher, before npm ci/build.
requireSupportedNode();
