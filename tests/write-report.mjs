import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function writeReport(name, report) {
  const root = process.env.CG_TEST_REPORT_DIR
    ? path.resolve(process.env.CG_TEST_REPORT_DIR)
    : fs.mkdtempSync(path.join(os.tmpdir(), 'cg-test-report-'));
  fs.mkdirSync(root, { recursive: true });
  const file = path.join(root, name);
  fs.writeFileSync(file, JSON.stringify(report, null, 2));
  console.log('REPORT ' + file);
}
