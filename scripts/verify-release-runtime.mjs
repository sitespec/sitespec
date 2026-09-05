const [major, minor] = process.versions.node.split('.').map(Number);

const supported =
  (major === 22 && minor >= 11) ||
  major === 24 ||
  major >= 26;

if (!supported) {
  console.error([
    `SiteSpec release tooling does not support Node.js ${process.versions.node}.`,
    'Changesets v3 requires Node.js ^22.11, ^24, or >=26.',
    'SiteSpec release CI uses Node.js 24.',
    '',
    'Switch to Node.js 24 before running release commands:',
    '  nvm install 24',
    '  nvm use 24',
    '  npm install --global npm@11.19.1',
    '  npm ci'
  ].join('\n'));
  process.exit(1);
}
