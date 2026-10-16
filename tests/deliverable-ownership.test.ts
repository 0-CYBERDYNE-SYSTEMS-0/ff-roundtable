import fs from "fs";
import os from "os";
import path from "path";
import { describe, expect, it } from "vitest";
import { canRevise, saveExpertDeliverable, extractPdfText, fetchPage } from "../server/expert-tools";

const finance = { name: "Farm Finance Advisor", role: "Farm Finance Advisor" };
const crop = { name: "Crop Specialist", role: "Crop Specialist" };
const owned = { uploadedBy: "Expert: Farm Finance Advisor" };

describe("document ownership", () => {
  it("author may revise; others need an explicit farmer handoff", () => {
    expect(canRevise(owned, finance)).toBe(true);
    expect(canRevise(owned, crop)).toBe(false);
    expect(canRevise(owned, crop, { farmerMessage: { content: "Thanks all", mentions: ["Crop Specialist"] } })).toBe(false);
    expect(canRevise(owned, crop, { farmerMessage: { content: "@Crop Specialist please update the checklist with drying", mentions: ["Crop Specialist"] } })).toBe(true);
    expect(canRevise(owned, crop, { farmerMessage: { content: "please update the checklist", mentions: ["Farm Finance Advisor"] } })).toBe(false);
  });

  it("a non-owner's edit becomes a separate proposal; the original is untouched", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "own-"));
    const files: Record<string, any> = {}; let id = 0;
    const store = {
      getCurrentDeliverableFile: async (_c: number, d: string) => files[d],
      saveDeliverableVersion: async (file: any, req: any) => {
        const prev = files[req.deliverableId];
        if (req.mode === "revise" && prev?.id !== req.expectedCurrentFileId) throw new Error("conflict");
        files[req.deliverableId] = { ...file, id: ++id, version: (prev?.version ?? 0) + 1 };
        return { file: files[req.deliverableId], created: true };
      },
    };
    const doc = { title: "Store vs Sell Checklist", content: "1. Get basis quote\n2. Price storage" };
    await saveExpertDeliverable(store, 1, finance, doc, dir);
    const p = await saveExpertDeliverable(store, 1, crop, { ...doc, content: "1. Check moisture first" }, dir);
    expect(p.proposalFor).toEqual({ title: "Store vs Sell Checklist", owner: "Farm Finance Advisor" });
    expect(p.title).toBe("Store vs Sell Checklist (proposed by Crop Specialist)");
    expect(files["expert-store-vs-sell-checklist"].version).toBe(1);
    const handoff = await saveExpertDeliverable(store, 1, crop, doc, dir, { farmerMessage: { content: "@Crop Specialist revise the checklist", mentions: ["Crop Specialist"] } });
    expect(handoff.proposalFor).toBeNull();
    expect(handoff.version).toBe(2);
  });
});

function tinyPdf(text: string): Uint8Array {
  const objs = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 100] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    null,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  const stream = `BT /F1 12 Tf 10 50 Td (${text}) Tj ET`;
  objs[3] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
  let out = "%PDF-1.4\n"; const offs: number[] = [];
  objs.forEach((o, i) => { offs.push(out.length); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` + offs.map(o => `${String(o).padStart(10, "0")} 00000 n \n`).join("");
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return new TextEncoder().encode(out);
}

describe("PDF sources", () => {
  it("extracts text from a PDF", async () => {
    expect(await extractPdfText(tinyPdf("Spider mites thrive in hot dry weather"))).toContain("Spider mites thrive");
  });
  it("fetchPage reads application/pdf responses", async () => {
    const fake = (async () => new Response(tinyPdf("Apply 30 lb N per acre"), { status: 200, headers: { "content-type": "application/pdf" } })) as any;
    const page = await fetchPage("https://93.184.216.34/bulletin.pdf", fake);
    expect(page.text).toContain("Apply 30 lb N per acre");
    expect(page.title).toBe("bulletin.pdf");
  });
});
