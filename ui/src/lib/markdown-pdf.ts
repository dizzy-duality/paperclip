import type { Content, TDocumentDefinitions } from "pdfmake/interfaces";
import type { PhrasingContent, RootContent, Table } from "mdast";
import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmFromMarkdown } from "mdast-util-gfm";
import { gfm } from "micromark-extension-gfm";

// pdfmake flat text runs. A style set on a run whose text is itself an array
// is not applied to the nested runs, so styles are pushed down onto each leaf.
type Run = { text: string; sup?: boolean; bold?: boolean; italics?: boolean; decoration?: "lineThrough" | "underline"; link?: string; style?: string; color?: string };

function styled(nodes: PhrasingContent[], style: Omit<Run, "text">): Run[] {
  return inline(nodes).map((run) => ({ ...style, ...run }));
}

function inline(nodes: PhrasingContent[]): Run[] {
  return nodes.flatMap((node): Run[] => {
    switch (node.type) {
      case "text": return [{ text: node.value }];
      case "strong": return styled(node.children, { bold: true });
      case "emphasis": return styled(node.children, { italics: true });
      case "delete": return styled(node.children, { decoration: "lineThrough" });
      case "inlineCode": return [{ text: node.value, style: "code" }];
      case "break": return [{ text: "\n" }];
      case "link": return styled(node.children, { link: node.url, color: "#2563eb", decoration: "underline" });
      case "image": return node.alt ? [{ text: `[${node.alt}]` }] : [];
      case "footnoteReference": return [{ text: `[${node.label ?? node.identifier}]`, sup: true }];
      case "html": return [{ text: node.value }];
      default: return "children" in node ? inline(node.children as PhrasingContent[]) : [];
    }
  });
}

function table(node: Table): Content {
  const body = node.children.map((row, rowIndex) =>
    row.children.map((cell) => ({ text: rowIndex === 0 ? styled(cell.children, { bold: true }) : inline(cell.children) })));
  const columns = Math.max(...body.map((row) => row.length));
  for (const row of body) while (row.length < columns) row.push({ text: [] });
  return { table: { headerRows: 1, widths: Array(columns).fill("*"), body }, layout: "lightHorizontalLines", margin: [0, 4, 0, 8] };
}

function block(node: RootContent): Content | null {
  switch (node.type) {
    case "heading": return { text: inline(node.children), style: `h${node.depth}` };
    case "paragraph": return { text: inline(node.children), margin: [0, 0, 0, 6] };
    case "code": return { text: node.value, style: "codeBlock" };
    case "blockquote": return { stack: blocks(node.children), margin: [12, 0, 0, 6], color: "#555555", italics: true };
    case "thematicBreak": return { canvas: [{ type: "line", x1: 0, y1: 4, x2: 515, y2: 4, lineWidth: 0.5, lineColor: "#cccccc" }], margin: [0, 4, 0, 8] };
    case "table": return table(node);
    case "list": {
      const items = node.children.map((item): Content => {
        // Task-list boxes as text: the bundled Roboto has no ballot-box glyphs.
        const check = item.checked === true ? "[x] " : item.checked === false ? "[ ] " : "";
        const [first, ...rest] = item.children;
        const lead = check && first?.type === "paragraph"
          ? [{ text: [{ text: check }, ...inline(first.children)], margin: [0, 0, 0, 6] } as Content, ...blocks(rest)]
          : blocks(item.children);
        return { stack: lead, margin: [0, 0, 0, 2] };
      });
      return node.ordered
        ? { ol: items, start: node.start ?? 1, margin: [0, 0, 0, 6] }
        : { ul: items, margin: [0, 0, 0, 6] };
    }
    case "html": return { text: node.value, margin: [0, 0, 0, 6] };
    // Rendered where the Markdown defines it, as "[label] text", in small type.
    case "footnoteDefinition": {
      const [first, ...rest] = node.children;
      const marker = { text: `[${node.label ?? node.identifier}] ` };
      const lead: Content[] = first?.type === "paragraph"
        ? [{ text: [marker, ...inline(first.children)], margin: [0, 0, 0, 3] }, ...blocks(rest)]
        : [{ text: [marker] }, ...blocks(node.children)];
      return { stack: lead, fontSize: 9, margin: [0, 2, 0, 4] };
    }
    default: return null;
  }
}

function blocks(nodes: RootContent[]): Content[] {
  return nodes.map(block).filter((content): content is Content => content !== null);
}

/** A pdfmake document for a Markdown document: its title, then its body. */
export function markdownToPdfDefinition(title: string, markdown: string): TDocumentDefinitions {
  const tree = fromMarkdown(markdown, { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] });
  return {
    info: { title },
    pageMargins: [40, 48, 40, 48],
    content: [{ text: title, style: "title" }, ...blocks(tree.children)],
    defaultStyle: { fontSize: 10.5, lineHeight: 1.25 },
    styles: {
      title: { fontSize: 20, bold: true, margin: [0, 0, 0, 12] },
      h1: { fontSize: 17, bold: true, margin: [0, 10, 0, 6] },
      h2: { fontSize: 14.5, bold: true, margin: [0, 10, 0, 5] },
      h3: { fontSize: 12.5, bold: true, margin: [0, 8, 0, 4] },
      h4: { fontSize: 11, bold: true, margin: [0, 6, 0, 3] },
      h5: { fontSize: 10.5, bold: true, margin: [0, 6, 0, 3] },
      h6: { fontSize: 10.5, bold: true, italics: true, margin: [0, 6, 0, 3] },
      code: { background: "#f1f1f1" },
      codeBlock: { fontSize: 9, background: "#f4f4f4", margin: [0, 2, 0, 8], preserveLeadingSpaces: true },
    },
  };
}

export function pdfFileName(name: string) {
  const base = name.trim().replace(/[\\/:*?"<>|]+/g, "-").replace(/\s+/g, " ") || "document";
  return `${base}.pdf`;
}

/** Builds the PDF in the browser and saves it. pdfmake and its fonts load on first use. */
export async function downloadMarkdownAsPdf(title: string, markdown: string, fileName: string) {
  const [{ default: pdfMake }, { default: vfs }] = await Promise.all([
    import("pdfmake/build/pdfmake"),
    import("pdfmake/build/vfs_fonts"),
  ]);
  pdfMake.addVirtualFileSystem(vfs);
  await pdfMake.createPdf(markdownToPdfDefinition(title, markdown)).download(pdfFileName(fileName));
}
