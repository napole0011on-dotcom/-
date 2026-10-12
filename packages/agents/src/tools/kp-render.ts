import { createRequire } from 'node:module';
import path from 'node:path';
import {
  AlignmentType,
  Document,
  HeadingLevel,
  Packer,
  Paragraph,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType,
} from 'docx';
import pdfmake from 'pdfmake';
import type { ObjectStorage } from '@cms/providers';
import type { AgentContext, AgentResult } from '../agents/context.js';
import type { KpOutput } from '../agents/kp.js';
import type { NodeExecutor, NodeFile, NodeInput, NodeRender } from '../nodes.js';
import { formatMoney } from './catalog.js';

const require = createRequire(import.meta.url);
/** Roboto from pdfmake itself (OFL, has Cyrillic): no fonts are downloaded at runtime. */
const FONTS_DIR = path.join(
  path.dirname(require.resolve('pdfmake/package.json')),
  'fonts',
  'Roboto',
);
pdfmake.setFonts({
  Roboto: {
    normal: path.join(FONTS_DIR, 'Roboto-Regular.ttf'),
    bold: path.join(FONTS_DIR, 'Roboto-Medium.ttf'),
    italics: path.join(FONTS_DIR, 'Roboto-Italic.ttf'),
    bolditalics: path.join(FONTS_DIR, 'Roboto-MediumItalic.ttf'),
  },
});
// The document never loads anything from the network or other folders.
pdfmake.setUrlAccessPolicy(() => false);
pdfmake.setLocalAccessPolicy((p) => path.resolve(p).startsWith(FONTS_DIR));

const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

const money = (minor: number | null, c: string) =>
  minor === null ? 'по запросу' : formatMoney(minor, c);
const totalText = (o: KpOutput) =>
  `${o.totals.hasOnRequest ? 'от ' : ''}${formatMoney(o.totals.totalMinor, o.totals.currency)}`;

export async function renderKpDocx(o: KpOutput): Promise<Buffer> {
  const c = o.totals.currency;
  const p = (text: string, opts: { bold?: boolean } = {}) =>
    new Paragraph({ children: [new TextRun({ text, bold: opts.bold ?? false })] });
  const cell = (text: string, bold = false) => new TableCell({ children: [p(text, { bold })] });
  const doc = new Document({
    sections: [
      {
        children: [
          ...(o.requisites
            ? [
                p(o.requisites.company, { bold: true }),
                p([o.requisites.details, o.requisites.contact].filter(Boolean).join(' · ')),
              ]
            : []),
          new Paragraph({
            text: `Коммерческое предложение для ${o.draft.client}`,
            heading: HeadingLevel.HEADING_1,
          }),
          p(o.draft.intro),
          new Paragraph({ text: 'Состав работ и стоимость', heading: HeadingLevel.HEADING_2 }),
          new Table({
            width: { size: 100, type: WidthType.PERCENTAGE },
            rows: [
              new TableRow({
                children: ['Услуга', 'Кол-во', 'Цена', 'Сумма'].map((h) => cell(h, true)),
              }),
              ...o.lines.map(
                (l) =>
                  new TableRow({
                    children: [
                      cell(l.comment ? `${l.name} — ${l.comment}` : l.name),
                      cell(`${l.qty} ${l.unit}`),
                      cell(money(l.priceMinor, c)),
                      cell(money(l.totalMinor, c)),
                    ],
                  }),
              ),
            ],
          }),
          new Paragraph({
            alignment: AlignmentType.RIGHT,
            children: [
              new TextRun({ text: `Итого: ${totalText(o)}`, bold: true }),
              new TextRun({
                text: o.totals.vatPercent
                  ? `, в т. ч. НДС ${o.totals.vatPercent}% ${formatMoney(o.totals.vatMinor, c)}`
                  : ', без НДС',
              }),
            ],
          }),
          ...(o.draft.timeline.length
            ? [
                new Paragraph({ text: 'Этапы и сроки', heading: HeadingLevel.HEADING_2 }),
                ...o.draft.timeline.map((t) => p(`${t.stage} — ${t.duration}`)),
              ]
            : []),
          ...(o.draft.assumptions.length
            ? [
                new Paragraph({ text: 'Исходные условия', heading: HeadingLevel.HEADING_2 }),
                ...o.draft.assumptions.map((a) => p(`• ${a}`)),
              ]
            : []),
          ...(o.cases.length
            ? [
                new Paragraph({ text: 'Кейсы', heading: HeadingLevel.HEADING_2 }),
                ...o.cases.map((x) => p(`${x.title}: ${x.text}`)),
              ]
            : []),
          new Paragraph({ text: 'Условия', heading: HeadingLevel.HEADING_2 }),
          p(o.draft.terms),
          new Paragraph({ text: 'Следующий шаг', heading: HeadingLevel.HEADING_2 }),
          p(o.draft.next_step),
        ],
      },
    ],
  });
  return Packer.toBuffer(doc);
}

export async function renderKpPdf(o: KpOutput): Promise<Buffer> {
  const c = o.totals.currency;
  const doc = {
    defaultStyle: { font: 'Roboto', fontSize: 10, lineHeight: 1.25 },
    styles: {
      h1: { fontSize: 16, bold: true, margin: [0, 8, 0, 8] },
      h2: { fontSize: 12, bold: true, margin: [0, 10, 0, 4] },
    },
    content: [
      ...(o.requisites
        ? [
            { text: o.requisites.company, bold: true },
            {
              text: [o.requisites.details, o.requisites.contact].filter(Boolean).join(' · '),
              color: '#666',
            },
          ]
        : []),
      { text: `Коммерческое предложение для ${o.draft.client}`, style: 'h1' },
      { text: o.draft.intro },
      { text: 'Состав работ и стоимость', style: 'h2' },
      {
        table: {
          headerRows: 1,
          widths: ['*', 'auto', 'auto', 'auto'],
          body: [
            ['Услуга', 'Кол-во', 'Цена', 'Сумма'].map((h) => ({ text: h, bold: true })),
            ...o.lines.map((l) => [
              l.comment ? `${l.name} — ${l.comment}` : l.name,
              `${l.qty} ${l.unit}`,
              money(l.priceMinor, c),
              money(l.totalMinor, c),
            ]),
          ],
        },
        layout: 'lightHorizontalLines',
      },
      {
        text: `Итого: ${totalText(o)}${o.totals.vatPercent ? `, в т. ч. НДС ${o.totals.vatPercent}% ${formatMoney(o.totals.vatMinor, c)}` : ', без НДС'}`,
        bold: true,
        alignment: 'right',
        margin: [0, 6, 0, 0],
      },
      ...(o.draft.timeline.length
        ? [
            { text: 'Этапы и сроки', style: 'h2' },
            { ul: o.draft.timeline.map((t) => `${t.stage} — ${t.duration}`) },
          ]
        : []),
      ...(o.draft.assumptions.length
        ? [{ text: 'Исходные условия', style: 'h2' }, { ul: o.draft.assumptions }]
        : []),
      ...(o.cases.length
        ? [{ text: 'Кейсы', style: 'h2' }, { ul: o.cases.map((x) => `${x.title}: ${x.text}`) }]
        : []),
      { text: 'Условия', style: 'h2' },
      { text: o.draft.terms },
      { text: 'Следующий шаг', style: 'h2' },
      { text: o.draft.next_step },
    ],
  };
  return pdfmake.createPdf(doc).getBuffer();
}

export interface KpRenderOutput {
  client: string;
  total: string;
  files: NodeFile[];
  warnings: string[];
}

/** Tool «КП → DOCX/PDF»: builds both documents from the КП step's result. No model, $0. */
export function kpRenderExecutor(d: { storage: ObjectStorage }): NodeExecutor {
  return {
    async run(ctx: AgentContext, input: NodeInput): Promise<AgentResult<KpRenderOutput>> {
      const kp = input.upstream.find((u) => u.agent === 'kp')?.items[0] as KpOutput | undefined;
      if (!kp?.lines)
        throw new Error('Нет результата агента КП: свяжите «КП → КП→DOCX/PDF» на доске');
      const base = `kp/${ctx.taskId}/${ctx.runId ?? 'test'}-${input.step}`;
      const docx = await renderKpDocx(kp);
      const pdf = await renderKpPdf(kp);
      const files: NodeFile[] = [
        { name: 'kp.docx', key: `${base}/kp.docx`, mimeType: DOCX_MIME },
        { name: 'kp.pdf', key: `${base}/kp.pdf`, mimeType: 'application/pdf' },
      ];
      await d.storage.put(files[0]!.key, docx, DOCX_MIME);
      await d.storage.put(files[1]!.key, pdf, 'application/pdf');
      return {
        output: { client: kp.draft.client, total: totalText(kp), files, warnings: kp.warnings },
        promptVersion: 'kp_render@code',
        model: 'tool',
        costUsd: 0,
      };
    },
    render(output: unknown): NodeRender {
      const o = output as KpRenderOutput;
      return {
        title: `Документы КП для ${o.client}: ${o.total}`,
        lines: [...o.files.map((f) => `Файл: ${f.name}`), ...o.warnings.map((w) => `⚠ ${w}`)],
      };
    },
    files(output: unknown): NodeFile[] {
      return (output as KpRenderOutput).files;
    },
  };
}
