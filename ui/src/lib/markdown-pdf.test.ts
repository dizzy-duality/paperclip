import { describe, expect, it } from "vitest";
import { markdownToPdfDefinition, pdfFileName } from "./markdown-pdf";

describe("markdownToPdfDefinition", () => {
  it("puts the title first and keeps inline styles on each text run", () => {
    const definition = markdownToPdfDefinition("Offerte", "Intro **bold *both*** and [link](https://x.test).\n\n- [x] done");
    const [title, paragraph, list] = definition.content as Array<Record<string, unknown>>;

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

  it("makes a safe PDF file name", () => {
    expect(pdfFileName('Offerte: "glas"/kit ')).toBe("Offerte- -glas-kit.pdf");
  });
});
