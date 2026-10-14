import { describe, expect, it } from "vitest";
import { markdownToPdfDefinition, pdfFileName } from "./markdown-pdf";

describe("markdownToPdfDefinition", () => {
  it("puts the title first and keeps inline styles on each text run", () => {
    const definition = markdownToPdfDefinition("Offerte", "Intro **bold *both*** and [link](https://x.test).\n\n- [x] done");
    const [title, paragraph, list] = definition.content as unknown as Array<Record<string, unknown>>;

    expect(title).toEqual({ text: "Offerte", style: "title" });
    expect(paragraph.text).toEqual([
      { text: "Intro " },
      { bold: true, text: "bold " },
      { bold: true, italics: true, text: "both" },
      { text: " and " },
      { link: "https://x.test", color: "#2563eb", decoration: "underline", text: "link" },
      { text: "." },
    ]);
    expect(JSON.stringify(list)).toContain('"text":"[x] "');
  });

  it("keeps footnote markers and their text", () => {
    const definition = markdownToPdfDefinition("Report", "Revenue rose.[^source]\n\n[^source]: Audited accounts, page 12.");
    const text = JSON.stringify(definition.content);

    expect(text).toContain('{"text":"[source]","sup":true}');
    expect(text).toContain('"text":[{"text":"[source] "},{"text":"Audited accounts, page 12."}]');
  });

  it("makes a safe PDF file name", () => {
    expect(pdfFileName('Offerte: "glas"/kit ')).toBe("Offerte- -glas-kit.pdf");
  });
});
