import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import JSZip from 'jszip';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  classifyPlanInput,
  docxToMarkdown,
  extractPlanInput,
  needsExtraction,
  parseSharedStrings,
  sidecarName,
  xlsxSheetToMarkdown,
} from './_plan-inputs.js';
import { planInputsStep, type PlanInputsDetect } from './00-plan-inputs.js';
import { planAgentCapabilities, type PlanBuildDetect } from './01-plan-build.js';

let dir: string;

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'haive-plan-inputs-'));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

function have(binary: string): boolean {
  try {
    execFileSync('sh', ['-c', `command -v ${binary}`], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

async function writeZip(name: string, members: Record<string, string>): Promise<string> {
  const zip = new JSZip();
  for (const [member, body] of Object.entries(members)) zip.file(member, body);
  const dest = path.join(dir, name);
  await writeFile(dest, await zip.generateAsync({ type: 'nodebuffer' }));
  return dest;
}

const docxDocument = (body: string): string =>
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`;

/* ------------------------------------------------------------------ */

describe('classifying an attachment', () => {
  it('reads the extension before the browser-supplied content type', () => {
    // File.type is empty for plenty of real uploads and occasionally wrong, so
    // it only gets to decide what the extension could not.
    expect(classifyPlanInput('spec.docx', '')).toBe('docx');
    expect(classifyPlanInput('data.xlsx', 'application/octet-stream')).toBe('xlsx');
    expect(classifyPlanInput('brief.md', '')).toBe('text');
    expect(classifyPlanInput('wireframe.png', '')).toBe('image');
    expect(classifyPlanInput('manual.pdf', '')).toBe('pdf');
  });

  it('falls back to the content type only for an unknown extension', () => {
    expect(classifyPlanInput('screenshot', 'image/png')).toBe('image');
    expect(classifyPlanInput('notes', 'text/plain')).toBe('text');
    expect(classifyPlanInput('payload', 'application/vnd.api+json')).toBe('text');
  });

  it('calls anything it does not recognise binary, never text', () => {
    // The whole point: a mis-decoded binary reaching the coverage term scan is
    // indistinguishable from a document that says nothing.
    expect(classifyPlanInput('archive.tar.gz', '')).toBe('binary');
    expect(classifyPlanInput('mystery', '')).toBe('binary');
  });

  it('treats an SVG as a picture, because that is what it was attached as', () => {
    expect(classifyPlanInput('wireframe.svg', 'image/svg+xml')).toBe('image');
  });

  it('needs a sidecar for exactly the three binary document kinds', () => {
    expect(['docx', 'xlsx', 'pdf'].every((k) => needsExtraction(k as never))).toBe(true);
    expect(['text', 'image', 'binary'].some((k) => needsExtraction(k as never))).toBe(false);
  });

  it('suffixes the sidecar rather than swapping the extension', () => {
    // spec.docx and spec.xlsx must not both become spec.md.
    expect(sidecarName('spec.docx')).toBe('spec.docx.extracted.md');
    expect(sidecarName('spec.xlsx')).not.toBe(sidecarName('spec.docx'));
  });
});

describe('docx extraction', () => {
  it('joins the runs of one paragraph back into a sentence', () => {
    // Word splits a sentence across runs on any formatting change, so a
    // separator between them corrupts every bolded word.
    const md = docxToMarkdown(
      docxDocument('<w:p><w:r><w:t>Members </w:t></w:r><w:r><w:t>must renew.</w:t></w:r></w:p>'),
    );
    expect(md).toBe('Members must renew.');
  });

  it('keeps headings as headings', () => {
    const md = docxToMarkdown(
      docxDocument(
        '<w:p><w:pPr><w:pStyle w:val="Heading2"/></w:pPr><w:r><w:t>Reporting</w:t></w:r></w:p>' +
          '<w:p><w:r><w:t>Monthly totals.</w:t></w:r></w:p>',
      ),
    );
    expect(md).toBe('## Reporting\n\nMonthly totals.');
  });

  it('renders a table without also emitting its cells as loose paragraphs', () => {
    // The cells are `<w:p>` too. Matching paragraphs globally printed every one
    // twice — once in its row and once adrift below the table.
    const md = docxToMarkdown(
      docxDocument(
        '<w:tbl>' +
          '<w:tr><w:tc><w:p><w:r><w:t>Field</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>Type</w:t></w:r></w:p></w:tc></w:tr>' +
          '<w:tr><w:tc><w:p><w:r><w:t>email</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>string</w:t></w:r></w:p></w:tc></w:tr>' +
          '</w:tbl>',
      ),
    );
    expect(md).toContain('| Field | Type |');
    expect(md).toContain('| email | string |');
    expect(md.match(/email/g)).toHaveLength(1);
  });

  it('keeps a table with the heading it sits under', () => {
    // Order is what tells the agent which requirements belong to which section.
    const md = docxToMarkdown(
      docxDocument(
        '<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Fields</w:t></w:r></w:p>' +
          '<w:tbl><w:tr><w:tc><w:p><w:r><w:t>a</w:t></w:r></w:p></w:tc></w:tr></w:tbl>' +
          '<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Reports</w:t></w:r></w:p>',
      ),
    );
    expect(md.indexOf('# Fields')).toBeLessThan(md.indexOf('| a |'));
    expect(md.indexOf('| a |')).toBeLessThan(md.indexOf('# Reports'));
  });

  it('decodes entities and escapes a pipe that would break the table', () => {
    const md = docxToMarkdown(
      docxDocument(
        '<w:tbl><w:tr><w:tc><w:p><w:r><w:t>a &amp; b | c</w:t></w:r></w:p></w:tc></w:tr></w:tbl>',
      ),
    );
    expect(md).toContain('a & b \\| c');
  });

  it('reads a real .docx off disk', async () => {
    const file = await writeZip('spec.docx', {
      'word/document.xml': docxDocument('<w:p><w:r><w:t>Renewal reminders.</w:t></w:r></w:p>'),
    });
    expect(await extractPlanInput('docx', file)).toEqual({
      markdown: 'Renewal reminders.',
      hasContent: true,
      error: null,
    });
  });
});

describe('xlsx extraction', () => {
  const strings = `<sst><si><t>Field</t></si><si><t>email</t></si></sst>`;

  it('resolves shared-string indices instead of printing them', () => {
    // `t="s"` means the value IS an index. Printing it turns a sheet of text
    // into a column of integers.
    const table = xlsxSheetToMarkdown(
      '<sheetData><row><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row></sheetData>',
      parseSharedStrings(strings),
    );
    expect(table).toContain('| Field | email |');
  });

  it('drops the phonetic reading rather than doubling the string', () => {
    expect(
      parseSharedStrings('<sst><si><t>東京</t><rPh><t>トウキョウ</t></rPh></si></sst>'),
    ).toEqual(['東京']);
  });

  it('keeps a formula beside the value it cached', () => {
    // In a requirements sheet the formula is often the requirement, while the
    // value is what the reader checks it against.
    const table = xlsxSheetToMarkdown('<c r="A1"><f>SUM(B1:B9)</f><v>41</v></c>', []);
    expect(table.join('\n')).toContain('=SUM(B1:B9) → 41');
  });

  it('orders columns the way a spreadsheet does', () => {
    // Lexically `AA` sorts before `B`, which silently reshuffles every sheet
    // wider than 26 columns.
    const table = xlsxSheetToMarkdown('<c r="AA1"><v>wide</v></c><c r="B1"><v>near</v></c>', []);
    expect(table[0]).toBe('| B | AA |');
  });

  it('reads a real .xlsx off disk, one section per named sheet', async () => {
    const file = await writeZip('data.xlsx', {
      'xl/workbook.xml':
        '<workbook><sheets><sheet name="Members" sheetId="1"/></sheets></workbook>',
      'xl/sharedStrings.xml': strings,
      'xl/worksheets/sheet1.xml':
        '<worksheet><sheetData><row><c r="A1" t="s"><v>0</v></c></row></sheetData></worksheet>',
    });
    const out = await extractPlanInput('xlsx', file);
    expect(out.error).toBeNull();
    expect(out.markdown).toContain('## Members');
    expect(out.markdown).toContain('| Field |');
  });
});

describe('failing to read an input', () => {
  it('records the reason instead of throwing', async () => {
    // The original is still mounted for whichever agent runs, so one corrupt
    // upload must not turn into a task that produces nothing at all.
    await writeFile(path.join(dir, 'broken.docx'), 'not a zip');
    const out = await extractPlanInput('docx', path.join(dir, 'broken.docx'));
    expect(out.markdown).toBe('');
    expect(out.error).toBeTruthy();
  });

  it('records a missing file rather than crashing the step', async () => {
    const out = await extractPlanInput('xlsx', path.join(dir, 'nope.xlsx'));
    expect(out.error).toBeTruthy();
  });

  it('reports an empty document as read-but-empty, not as unreadable', async () => {
    // Different facts about the input. "Says nothing" is the document's problem;
    // "could not be read" is ours, and the index words them differently.
    const file = await writeZip('empty.docx', { 'word/document.xml': docxDocument('') });
    expect(await extractPlanInput('docx', file)).toEqual({
      markdown: '',
      hasContent: false,
      error: null,
    });
  });

  it('refuses to guess at a kind it has no extractor for', async () => {
    const out = await extractPlanInput('image', path.join(dir, 'anything.png'));
    expect(out.error).toContain('no extractor');
  });
});

describe.skipIf(!have('pdftotext'))('pdf extraction', () => {
  it('reads the text of a real PDF', async () => {
    const body = 'BT /F1 12 Tf 20 100 Td (Renewal reminders) Tj ET';
    const pdf = [
      '%PDF-1.4',
      '1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj',
      '2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj',
      '3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 300 200]/Contents 4 0 R' +
        '/Resources<</Font<</F1 5 0 R>>>>>>endobj',
      `4 0 obj<</Length ${body.length}>>stream`,
      body,
      'endstream endobj',
      '5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj',
      'trailer<</Root 1 0 R/Size 6>>',
      '%%EOF',
    ].join('\n');
    const file = path.join(dir, 'manual.pdf');
    await writeFile(file, pdf, 'latin1');
    const out = await extractPlanInput('pdf', file);
    expect(out.error).toBeNull();
    expect(out.markdown).toContain('Renewal reminders');
  });
});

describe('the plan-inputs step', () => {
  const ctx = { taskId: 't1', repoPath: '/repo', logger: { warn() {} } } as never;
  const detected = (over: Partial<PlanInputsDetect> = {}): PlanInputsDetect => ({
    greenfield: true,
    briefLength: 0,
    uploadsDir: null,
    attachments: [],
    missing: [],
    ...over,
  });
  const apply = (d: PlanInputsDetect) =>
    planInputsStep.apply(ctx, {
      detected: d,
      formValues: {},
      iteration: 0,
      previousIterations: [],
    });

  it('names the files it could not find rather than building the wrong plan', async () => {
    // A plan decomposed from a document that is not there is a plausible plan of
    // a different project, which is worse than no plan at all.
    await expect(apply(detected({ missing: ['requirements.docx'] }))).rejects.toThrow(
      /requirements\.docx/,
    );
  });

  it('refuses a greenfield build with no brief and no files', async () => {
    // The API accepts this at create time because the uploads have not happened
    // yet; here both facts are finally known.
    await expect(apply(detected())).rejects.toThrow(/nothing to build from/);
  });

  it('accepts a brief with no files', async () => {
    const out = await apply(detected({ briefLength: 40 }));
    expect(out.inputs).toEqual([]);
    expect(out.indexPath).toBeNull();
  });

  it('does not impose the greenfield rule on a repository build', async () => {
    // from_repo reads the knowledge base; it needs neither a brief nor a file.
    const out = await apply(detected({ greenfield: false }));
    expect(out.hasImageInputs).toBe(false);
  });
});

describe('what a model has to be able to SEE', () => {
  const detect = (visualOnlyInputs: string[]): PlanBuildDetect =>
    ({
      mode: 'greenfield',
      repositoryId: 'r1',
      existingNodeCount: 0,
      hasRoot: false,
      kbFiles: [],
      brief: '',
      repoName: 'x',
      visualOnlyInputs,
    }) as PlanBuildDetect;

  it('requires vision when an image is attached', () => {
    expect(planAgentCapabilities(detect(['wireframe.png']))).toEqual(['tool_use', 'vision']);
  });

  it('requires vision for a PDF that yielded no text', () => {
    // The case this exists for: a wireframe PDF is large because of its pictures,
    // so pdftotext returns nothing and the sidecar is empty. With no text form
    // left, a blind model would plan around it and report success.
    expect(planAgentCapabilities(detect(['wireframes.pdf']))).toEqual(['tool_use', 'vision']);
  });

  it('does not require vision when every input has a readable form', () => {
    // Most builds carry no picture. Demanding vision unconditionally would lock
    // every blind model out of all of them.
    expect(planAgentCapabilities(detect([]))).toEqual(['tool_use']);
  });

  it('does not require vision for a build with no prepared inputs at all', () => {
    // The onboarding wrapper runs the same builder with no 00-plan-inputs step.
    expect(planAgentCapabilities({ mode: 'from_repo' } as PlanBuildDetect)).toEqual(['tool_use']);
  });
});

describe('deciding whether a document says anything', () => {
  // The regression this section exists for. `hasContent` gates the HARD vision
  // requirement, so a false positive here is the silent-skip failure the whole
  // feature is meant to prevent: a wireframe reaching a model that cannot see it,
  // and a plan built around it that reports success.

  it.skipIf(!have('pdftotext'))('calls an all-picture PDF empty, not "---"', async () => {
    // MEASURED on a 31 MiB wireframe export: pdftotext returned one form feed,
    // the page-separator rule turned it into `---`, `.trim()` left that standing,
    // and the file was recorded as having text. The separator is scaffolding this
    // module adds; it can never be evidence about the input.
    const page =
      '%PDF-1.4\n1 0 obj\n<</Type/Catalog/Pages 2 0 R>>\nendobj\n' +
      '2 0 obj\n<</Type/Pages/Kids[3 0 R]/Count 1>>\nendobj\n' +
      '3 0 obj\n<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>\nendobj\n' +
      'trailer\n<</Size 4/Root 1 0 R>>\n%%EOF\n';
    const file = path.join(dir, 'blank.pdf');
    await writeFile(file, page, 'latin1');
    const out = await extractPlanInput('pdf', file);
    expect(out.error).toBeNull();
    expect(out.hasContent).toBe(false);
    expect(out.markdown).toBe('');
  });

  it('calls a workbook of empty sheets empty, despite rendering its headings', async () => {
    // Same shape: `## Sheet1` and `_(empty)_` are always emitted, so the rendered
    // string is never blank however little the workbook holds.
    const file = await writeZip('blank.xlsx', {
      'xl/workbook.xml': '<workbook><sheets><sheet name="Sheet1" sheetId="1"/></sheets></workbook>',
      'xl/worksheets/sheet1.xml': '<worksheet><sheetData/></worksheet>',
    });
    const out = await extractPlanInput('xlsx', file);
    expect(out.error).toBeNull();
    expect(out.hasContent).toBe(false);
    // The rendered form still shows the sheet — that is fine, and exactly why the
    // verdict cannot be a test on this string.
    expect(out.markdown).toContain('## Sheet1');
  });

  it('still calls a populated workbook non-empty', async () => {
    const file = await writeZip('full.xlsx', {
      'xl/workbook.xml': '<workbook><sheets><sheet name="S" sheetId="1"/></sheets></workbook>',
      'xl/worksheets/sheet1.xml':
        '<worksheet><sheetData><row><c r="A1"><v>7</v></c></row></sheetData></worksheet>',
    });
    expect((await extractPlanInput('xlsx', file)).hasContent).toBe(true);
  });

  it('reports an unreadable file as having no content either', async () => {
    await writeFile(path.join(dir, 'junk.xlsx'), 'not a zip');
    const out = await extractPlanInput('xlsx', path.join(dir, 'junk.xlsx'));
    expect(out.error).toBeTruthy();
    expect(out.hasContent).toBe(false);
  });
});
