import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);

/**
 * Turning a task's attachments into something every CLI can actually read.
 *
 * A plan may be handed a Word requirements doc, a spreadsheet of fields, a PDF
 * and a wireframe in one go. Every CLI can be given the ORIGINAL bytes — the
 * uploads dir is bind-mounted read-only into the sandbox — but not every model
 * can understand every format, and a model that silently fails to read one has
 * produced a plan missing whatever it said. So each binary document also gets a
 * plain-text sidecar, and the index (`_PLAN_INPUTS.md`) says which is which.
 *
 * No new dependency. DOCX and XLSX are ZIP archives of OOXML, read here with the
 * `unzip` binary the worker image already carries (packages/worker/Dockerfile) —
 * the same way repo/clone.ts extracts an uploaded archive — and PDFs go through
 * `pdftotext`. The element names matched below (`w:p`, `w:t`, `sst`, `sheetData`)
 * are ISO-29500, a frozen published standard, so this matches an invariant
 * rather than someone's formatting. Nothing in the pnpm store parses XML.
 */

export type PlanInputKind = 'text' | 'docx' | 'xlsx' | 'pdf' | 'image' | 'binary';

/** Extensions whose contents an agent can simply open. Deliberately a small
 *  allowlist: anything unrecognised is `binary` and is never decoded as UTF-8,
 *  because a mis-decoded PNG reaching a coverage term scan is indistinguishable
 *  from a document that says nothing. */
const TEXT_EXTENSIONS = new Set([
  '.md',
  '.markdown',
  '.txt',
  '.text',
  '.csv',
  '.tsv',
  '.json',
  '.yaml',
  '.yml',
  '.xml',
  '.html',
  '.htm',
  '.rst',
  '.adoc',
  '.org',
]);

/** `.svg` is in here rather than with the text kinds on purpose: it is markup, but
 *  what a user attaches one FOR is the picture, and reading its path data is not
 *  reading the design. */
const IMAGE_EXTENSIONS = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.avif',
  '.bmp',
  '.svg',
]);

/** Classify by EXTENSION first. The recorded content type comes from the
 *  browser's `File.type` and is empty for plenty of real files (and wrong for
 *  some), so it only decides what the extension could not. */
export function classifyPlanInput(filename: string, contentType?: string | null): PlanInputKind {
  const ext = path.extname(filename).toLowerCase();
  if (ext === '.docx') return 'docx';
  if (ext === '.xlsx') return 'xlsx';
  if (ext === '.pdf') return 'pdf';
  if (IMAGE_EXTENSIONS.has(ext)) return 'image';
  if (TEXT_EXTENSIONS.has(ext)) return 'text';

  const type = (contentType ?? '').toLowerCase();
  if (type.startsWith('image/')) return 'image';
  if (type === 'application/pdf') return 'pdf';
  if (type.startsWith('text/')) return 'text';
  if (type === 'application/json' || type.endsWith('+json')) return 'text';
  return 'binary';
}

/** Kinds whose readable form is an extracted sidecar rather than the file itself. */
export function needsExtraction(kind: PlanInputKind): boolean {
  return kind === 'docx' || kind === 'xlsx' || kind === 'pdf';
}

/* ------------------------------------------------------------------ */
/* XML helpers (OOXML only — not a general parser)                      */
/* ------------------------------------------------------------------ */

const XML_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
};

function decodeXmlText(raw: string): string {
  return raw.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, body: string) => {
    if (body.startsWith('#x') || body.startsWith('#X')) {
      const code = Number.parseInt(body.slice(2), 16);
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
    }
    if (body.startsWith('#')) {
      const code = Number.parseInt(body.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
    }
    return XML_ENTITIES[body] ?? whole;
  });
}

/** Every `<tag ...>…</tag>` body, in document order. Namespace prefix included in
 *  `tag` (`w:p`), since OOXML's prefixes are fixed by the standard. Self-closing
 *  elements match with an empty body, which matters: an empty `<w:p/>` is a blank
 *  paragraph, not an absent one. */
function elements(xml: string, tag: string): string[] {
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?(?:/>|>([\\s\\S]*?)</${tag}>)`, 'g');
  const out: string[] = [];
  for (const m of xml.matchAll(re)) out.push(m[1] ?? '');
  return out;
}

/** One attribute off the FIRST occurrence of `tag`. */
function attribute(xml: string, tag: string, attr: string): string | null {
  const m = new RegExp(`<${tag}\\b[^>]*\\s${attr}="([^"]*)"`).exec(xml);
  return m ? decodeXmlText(m[1] ?? '') : null;
}

/* ------------------------------------------------------------------ */
/* ZIP member reads                                                     */
/* ------------------------------------------------------------------ */

/** One member of a zip, as text. `-p` writes it to stdout and nothing else, so
 *  no temp dir is needed. A member that is not there exits non-zero, which the
 *  callers below treat as "this document has no such part". */
export async function unzipMember(archivePath: string, member: string): Promise<string> {
  const { stdout } = await exec('unzip', ['-p', archivePath, member], {
    maxBuffer: 64 * 1024 * 1024,
    encoding: 'utf8',
  });
  return stdout;
}

async function unzipMemberOrNull(archivePath: string, member: string): Promise<string | null> {
  return unzipMember(archivePath, member).catch(() => null);
}

/** Member paths inside the archive, from `unzip -Z1`. Needed for XLSX, whose
 *  worksheet parts are numbered rather than named. */
async function listZipMembers(archivePath: string): Promise<string[]> {
  const { stdout } = await exec('unzip', ['-Z1', archivePath], {
    maxBuffer: 8 * 1024 * 1024,
    encoding: 'utf8',
  });
  return stdout
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

/* ------------------------------------------------------------------ */
/* DOCX                                                                 */
/* ------------------------------------------------------------------ */

/** The visible text of one paragraph: every `<w:t>` run concatenated, with
 *  `<w:tab/>` and `<w:br/>` kept as whitespace. Runs are split by formatting, so
 *  a single sentence is routinely several of them — joining without a separator
 *  is what reassembles the sentence. */
function docxParagraphText(paragraphXml: string): string {
  const withBreaks = paragraphXml
    .replace(/<w:tab\b[^>]*\/?>/g, '\t')
    .replace(/<w:br\b[^>]*\/?>/g, '\n');
  return decodeXmlText(elements(withBreaks, 'w:t').join('')).trim();
}

/** `Heading2` -> 2. Word also spells the built-ins `heading 2` in some locales'
 *  documents, hence the loose match; an unrecognised style is simply body text. */
function docxHeadingLevel(paragraphXml: string): number | null {
  const style = attribute(paragraphXml, 'w:pStyle', 'w:val');
  if (!style) return null;
  const m = /^heading\s*([1-9])$/i.exec(style.trim());
  return m ? Number(m[1]) : null;
}

function docxTableMarkdown(tableXml: string): string[] {
  const rows = elements(tableXml, 'w:tr').map((row) =>
    elements(row, 'w:tc').map((cell) =>
      elements(cell, 'w:p').map(docxParagraphText).filter(Boolean).join(' ').replace(/\|/g, '\\|'),
    ),
  );
  const populated = rows.filter((cells) => cells.some((cell) => cell.length > 0));
  if (populated.length === 0) return [];
  const width = Math.max(...populated.map((cells) => cells.length));
  const pad = (cells: string[]): string =>
    `| ${Array.from({ length: width }, (_, i) => cells[i] ?? '').join(' | ')} |`;
  const [header, ...body] = populated;
  return [
    pad(header!),
    `| ${Array.from({ length: width }, () => '---').join(' | ')} |`,
    ...body.map(pad),
  ];
}

/**
 * DOCX body as Markdown: headings, paragraphs and tables, in document order.
 *
 * Order matters more than fidelity here — a plan agent needs to know which
 * requirements sit under which heading, and a table read out of place attaches
 * its rows to the wrong section. So the body is walked once and each top-level
 * `<w:p>` / `<w:tbl>` emitted where it appears, rather than collecting all the
 * paragraphs and then all the tables.
 */
export function docxToMarkdown(documentXml: string): string {
  const body = elements(documentXml, 'w:body')[0] ?? documentXml;
  const out: string[] = [];
  // One scan over both block kinds, which is what keeps a table's rows attached
  // to the heading above them. It also means a table is consumed WHOLE: the match
  // advances past its closing tag, so the `<w:p>` elements inside its cells are
  // never also emitted as loose paragraphs.
  //
  // A table nested inside a cell is the one case this reads imperfectly — the
  // non-greedy close binds to the inner `</w:tbl>` and the outer table's
  // remaining rows come out as plain paragraphs. Degraded, never duplicated, and
  // not worth a real parser for how rarely a requirements document does it.
  const blockRe = /<(w:p|w:tbl)(?:\s[^>]*)?(?:\/>|>([\s\S]*?)<\/\1>)/g;
  for (const m of body.matchAll(blockRe)) {
    const inner = m[2] ?? '';
    if (m[1] === 'w:tbl') {
      const table = docxTableMarkdown(inner);
      if (table.length > 0) out.push('', ...table, '');
      continue;
    }
    const text = docxParagraphText(inner);
    if (!text) {
      if (out.at(-1) !== '') out.push('');
      continue;
    }
    const level = docxHeadingLevel(inner);
    out.push(level ? `${'#'.repeat(Math.min(level, 6))} ${text}` : text, '');
  }
  return out
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/* ------------------------------------------------------------------ */
/* XLSX                                                                 */
/* ------------------------------------------------------------------ */

/** `B7` -> `B`. Column letters, for laying a sparse sheet out as a table. */
function cellColumn(ref: string): string {
  return /^([A-Z]+)/.exec(ref)?.[1] ?? '';
}

function cellRow(ref: string): number {
  return Number(/(\d+)$/.exec(ref)?.[1] ?? '0');
}

/** Column letters ordered the way a spreadsheet orders them: by LENGTH first, so
 *  `Z` precedes `AA`. A plain lexical sort puts `AA` before `B` and silently
 *  reorders every sheet wider than 26 columns. */
function compareColumns(a: string, b: string): number {
  return a.length - b.length || a.localeCompare(b);
}

/**
 * One sheet as Markdown, non-empty cells only.
 *
 * A formula cell carries BOTH its `<f>` source and the `<v>` value Excel last
 * cached; both are kept (`=SUM(B2:B9) → 41`) because a requirements sheet's
 * formula is often the requirement, while its value is what the reader checks
 * against.
 */
export function xlsxSheetToMarkdown(sheetXml: string, sharedStrings: string[]): string[] {
  type Cell = { column: string; row: number; text: string };
  const cells: Cell[] = [];

  for (const m of sheetXml.matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
    const attrs = m[1] ?? '';
    const inner = m[2] ?? '';
    const ref = /\sr="([^"]+)"/.exec(attrs)?.[1] ?? '';
    if (!ref) continue;
    const type = /\st="([^"]+)"/.exec(attrs)?.[1] ?? 'n';

    let value: string;
    if (type === 'inlineStr') {
      value = decodeXmlText(elements(inner, 't').join('')).trim();
    } else {
      const raw = decodeXmlText(elements(inner, 'v')[0] ?? '').trim();
      // `s` means the value is an INDEX into the shared string table, not the
      // string itself. Rendering the index is how a spreadsheet full of text
      // comes out as a column of integers.
      value = type === 's' ? (sharedStrings[Number(raw)] ?? '') : raw;
    }

    const formula = decodeXmlText(elements(inner, 'f')[0] ?? '').trim();
    const text = formula ? (value ? `=${formula} → ${value}` : `=${formula}`) : value;
    if (!text) continue;
    cells.push({ column: cellColumn(ref), row: cellRow(ref), text: text.replace(/\|/g, '\\|') });
  }
  if (cells.length === 0) return [];

  const columns = [...new Set(cells.map((c) => c.column))].sort(compareColumns);
  const rows = [...new Set(cells.map((c) => c.row))].sort((a, b) => a - b);
  const at = new Map(cells.map((c) => [`${c.column}${c.row}`, c.text]));
  const line = (row: number): string =>
    `| ${columns.map((col) => at.get(`${col}${row}`) ?? '').join(' | ')} |`;

  return [
    `| ${columns.join(' | ')} |`,
    `| ${columns.map(() => '---').join(' | ')} |`,
    ...rows.map(line),
  ];
}

/** The shared string table: one entry per `<si>`, its `<t>` runs concatenated
 *  (a styled string is split into several). Index-addressed, so a dropped entry
 *  shifts every later cell onto the wrong text — which is why the array is built
 *  from every `<si>` including empty ones. */
export function parseSharedStrings(xml: string): string[] {
  return elements(xml, 'si').map((si) =>
    // `<rPh>` holds the phonetic reading of the run beside it and carries its own
    // `<t>`; concatenating it doubles every East-Asian string.
    decodeXmlText(elements(si.replace(/<rPh\b[\s\S]*?<\/rPh>/g, ''), 't').join('')),
  );
}

/* ------------------------------------------------------------------ */
/* Extraction                                                           */
/* ------------------------------------------------------------------ */

export interface ExtractionResult {
  /** The readable text, empty when the document genuinely had none. */
  markdown: string;
  /** Whether the DOCUMENT carried any text, decided from its own content and
   *  never from the rendered string.
   *
   *  The two differ, and the difference is load-bearing. This renderer adds
   *  scaffolding of its own — a `---` between pages, a `## Sheet` heading, an
   *  `_(empty)_` placeholder — none of which is whitespace, so `markdown.trim()`
   *  is non-empty for a document that says nothing at all. MEASURED: a 31 MiB
   *  wireframe PDF extracted to exactly `---`, was read as having text, and the
   *  vision requirement that exists to stop a blind model planning around it did
   *  not fire. Emptiness is a fact about the input; do not re-derive it from
   *  output this module formatted. */
  hasContent: boolean;
  /** Why nothing could be read. `null` on success INCLUDING an empty document —
   *  "unreadable" and "says nothing" are different facts about an input and the
   *  index reports them differently. */
  error: string | null;
}

async function extractDocx(filePath: string): Promise<ExtractionResult> {
  const xml = await unzipMember(filePath, 'word/document.xml');
  const markdown = docxToMarkdown(xml);
  // Nothing is added around a docx body, so the rendered string IS the content.
  return { markdown, hasContent: markdown.length > 0, error: null };
}

async function extractXlsx(filePath: string): Promise<ExtractionResult> {
  const [workbook, strings, members] = await Promise.all([
    unzipMemberOrNull(filePath, 'xl/workbook.xml'),
    unzipMemberOrNull(filePath, 'xl/sharedStrings.xml'),
    listZipMembers(filePath),
  ]);
  const sharedStrings = strings ? parseSharedStrings(strings) : [];
  // Sheet NAMES are in the workbook part, sheet CONTENT in numbered parts. They
  // are paired by position rather than by r:id: resolving r:id means reading a
  // third part (the rels file) to learn an ordering the workbook already states.
  const names = workbook
    ? elements(workbook, 'sheets')
        .flatMap((s) => [...s.matchAll(/<sheet\b[^>]*\sname="([^"]*)"/g)])
        .map((m) => decodeXmlText(m[1] ?? ''))
    : [];
  const partOrdinal = (member: string): number => Number(/(\d+)/.exec(member)?.[1] ?? 0);
  const sheetParts = members
    .filter((m) => /^xl\/worksheets\/sheet\d+\.xml$/.test(m))
    // Numeric, not lexical: `sheet10` sorts before `sheet2` as a string, which
    // pairs every later sheet with the wrong name.
    .sort((a, b) => partOrdinal(a) - partOrdinal(b));

  const out: string[] = [];
  // Counted separately from `out`, which always has the sheet headings in it: a
  // workbook of empty sheets renders several lines and carries no content.
  let populatedSheets = 0;
  for (const [i, part] of sheetParts.entries()) {
    const sheetXml = await unzipMemberOrNull(filePath, part);
    if (sheetXml === null) continue;
    const table = xlsxSheetToMarkdown(sheetXml, sharedStrings);
    if (table.length > 0) populatedSheets += 1;
    const title = names[i] ?? `Sheet ${i + 1}`;
    out.push(`## ${title}`, '');
    out.push(...(table.length > 0 ? table : ['_(empty)_']), '');
  }
  return { markdown: out.join('\n').trim(), hasContent: populatedSheets > 0, error: null };
}

async function extractPdf(filePath: string): Promise<ExtractionResult> {
  // `-layout` keeps columns and tables roughly where they were; the default
  // reflows a two-column page into interleaved nonsense.
  //
  // 64 MiB of stdout is far past any real document's text — a large PDF is large
  // because of its images, and its text is a few labels — so the buffer is not
  // the binding constraint on how big an upload may be.
  const { stdout } = await exec('pdftotext', ['-layout', '-enc', 'UTF-8', filePath, '-'], {
    maxBuffer: 64 * 1024 * 1024,
    encoding: 'utf8',
  });
  // Split on the form feed poppler writes between pages and drop the blank ones
  // BEFORE joining. Adding the rule first and trimming after is what made an
  // all-picture PDF extract to a lone `---` and read as having text.
  const pages = stdout
    .split('\f')
    .map((page) => page.trim())
    .filter(Boolean);
  return { markdown: pages.join('\n\n---\n\n'), hasContent: pages.length > 0, error: null };
}

/**
 * The readable text of one attachment, or the reason there is none.
 *
 * Never throws. An unreadable document is a fact to REPORT, not a reason to fail
 * the step: the original is still mounted for whichever agent runs, so the plan
 * can still be built from it — just not by a term scan. Failing here would turn
 * one corrupt upload into a task that produces nothing at all.
 */
export async function extractPlanInput(
  kind: PlanInputKind,
  filePath: string,
): Promise<ExtractionResult> {
  try {
    if (kind === 'docx') return await extractDocx(filePath);
    if (kind === 'xlsx') return await extractXlsx(filePath);
    if (kind === 'pdf') return await extractPdf(filePath);
    return { markdown: '', hasContent: false, error: `no extractor for ${kind}` };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { markdown: '', hasContent: false, error: message.split('\n')[0]!.slice(0, 300) };
  }
}

/** Sidecar name for an original. Suffixed rather than extension-swapped so
 *  `spec.docx` and `spec.xlsx` cannot collide on one `spec.md`. */
export function sidecarName(filename: string): string {
  return `${filename}.extracted.md`;
}

/**
 * `dir/name`, but only when the result is still inside `dir`. Null otherwise.
 *
 * `name` comes from `task_attachments.filename` — a column, not a literal. The
 * api sanitises it on upload today, but this package cannot see that sanitiser
 * and cannot be sure it ran: a row written before it existed, or by any future
 * writer, arrives here unchecked. The two things built from that column are a
 * file this step WRITES and a file coverage READS straight into a prompt, so an
 * unchecked `../` is an arbitrary write and an arbitrary read.
 *
 * Checked on the RESOLVED path rather than by scanning the string for `..`,
 * which is the test that actually holds: it survives encoding tricks, a
 * separator this platform accepts and the pattern does not, and an absolute path
 * (which `join` would not even keep). The trailing separator matters too —
 * without it `/uploads/<id>` would admit `/uploads/<id>-evil`.
 */
export function resolveInside(dir: string, name: string): string | null {
  const base = path.resolve(dir);
  const candidate = path.resolve(base, name);
  return candidate === base || candidate.startsWith(base + path.sep) ? candidate : null;
}
