// 共通雛形 /home/choucrin/projects/automation/browser/playwright.config.cjs を基に、
// F-11-1(幅 320px)のため iPhone SE 相当の WebKit 条件を追加した。
// Ubuntu 上の端末エミュレーションであり、iOS / iPadOS 実機検証ではない(Test.md 参照)。
const { defineConfig, devices } = require(process.env.DEVFLOW_PLAYWRIGHT_TEST);
const path = require('node:path');
const output = process.env.DEVFLOW_BROWSER_OUTPUT;
if (!output) throw new Error('Run through devflow-browser');
module.exports = defineConfig({
  testDir: __dirname,
  testMatch: '**/*.spec.cjs',
  timeout: 60000, workers: 1, retries: 0, forbidOnly: true,
  outputDir: path.join(output, 'test-results'),
  reporter: [['line'], ['json', { outputFile: path.join(output, 'results.json') }],
             ['html', { outputFolder: path.join(output, 'html'), open: 'never' }]],
  use: { headless: true, trace: 'on', screenshot: 'on', video: 'retain-on-failure',
         serviceWorkers: 'block' },
  projects: [
    { name: 'iphone-portrait', use: { ...devices['iPhone 13'], browserName: 'webkit' } },
    { name: 'iphone-landscape', use: { ...devices['iPhone 13 landscape'], browserName: 'webkit' } },
    { name: 'ipad-portrait', use: { ...devices['iPad Pro 11'], browserName: 'webkit' } },
    { name: 'ipad-landscape', use: { ...devices['iPad Pro 11 landscape'], browserName: 'webkit' } },
    { name: 'desktop-chromium', use: { ...devices['Desktop Chrome'], browserName: 'chromium' } },
    { name: 'iphone-320', use: { ...devices['iPhone SE'], browserName: 'webkit' } },
  ],
});
