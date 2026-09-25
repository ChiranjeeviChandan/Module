// Generates samples/sample-physics-module.pdf: a small JEE-style module with
// deliberately planted errors, for trying the app end to end.
import fs from "node:fs";
import { createRequire } from "node:module";
import PDFDocument from "pdfkit";

const require = createRequire(import.meta.url);
const F = require.resolve("dejavu-fonts-ttf/package.json").replace(/package\.json$/, "ttf/");

fs.mkdirSync("samples", { recursive: true });
const doc = new PDFDocument({ size: "A4", margins: { top: 60, bottom: 60, left: 60, right: 60 } });
doc.pipe(fs.createWriteStream("samples/sample-physics-module.pdf"));
doc.registerFont("serif", F + "DejaVuSerif.ttf");
doc.registerFont("serifB", F + "DejaVuSerif-Bold.ttf");
doc.registerFont("sans", F + "DejaVuSans.ttf");
doc.registerFont("sansB", F + "DejaVuSans-Bold.ttf");

const header = (t: string) => {
  doc.rect(0, 0, doc.page.width, 38).fill("#12306b");
  doc.font("sansB").fontSize(10).fillColor("#ffffff").text(t, 60, 14);
  doc.fillColor("#000000").font("serif").fontSize(11);
  doc.y = 70;
};

header("JEE MAIN · PHYSICS · CLASS 11 · MODULE 3");
doc.font("sansB").fontSize(20).fillColor("#12306b").text("Chapter 3: Motion in a Straight Line");
doc.moveDown(0.4);
doc.font("sansB").fontSize(13).fillColor("#b34700").text("3.1 Kinematic Equations");
doc.moveDown(0.3);
doc.font("serif").fontSize(11).fillColor("#000000").text(
  "For a particle moving with uniform acceleration a, the velocity after time t is v = u + at and the displacement is s = ut + at². " +
  "Eliminating t between these gives the third equation of motion, v² = u² + as. These equations are valid only when the acceleration is constant in both magnitude and direction.",
  { align: "justify" },
);
doc.moveDown(0.6);
const boxY = doc.y;
doc.rect(60, boxY, doc.page.width - 120, 70).fill("#fff4d6");
doc.fillColor("#7a4b00").font("sansB").fontSize(10).text("KEY POINT", 72, boxY + 10);
doc.fillColor("#222222").font("serif").fontSize(11).text("The area under a velocity–time graph gives the accelaration of the particle over that interval.", 72, boxY + 26, { width: doc.page.width - 144 });
doc.y = boxY + 84;
doc.x = 60;
doc.font("sansB").fontSize(13).fillColor("#b34700").text("3.2 Free Fall");
doc.moveDown(0.3);
doc.font("serif").fontSize(11).fillColor("#000000").text(
  "Near the surface of the Earth, all bodies fall with the same acceleration g ≈ 9.8 m/s in the absence of air resistance. A body dropped from rest covers a distance h = gt² in time t.",
  { align: "justify" },
);
doc.moveDown(0.8);
doc.font("sansB").fontSize(13).fillColor("#12306b").text("Exercise 3A");
doc.moveDown(0.3);
doc.font("serif").fontSize(11).fillColor("#000000");
doc.text("Q1. A car starts from rest and accelerates uniformly at 2 m/s² for 5 s. The distance covered is");
doc.text("(A) 10 m      (B) 25 m      (C) 50 m      (D) 5 m");
doc.moveDown(0.4);
doc.text("Q2. A stone is dropped from a height of 45 m. Taking g = 10 m/s², the time taken to reach the ground is");
doc.text("(A) 2 s      (B) 3 s      (C) 4.5 s      (D) 9 s");
doc.moveDown(0.8);
doc.font("sansB").fontSize(11).fillColor("#12306b").text("Answer Key");
doc.font("serif").fontSize(11).fillColor("#000000").text("Q1. (C)      Q2. (B)");
doc.end();
console.log("wrote samples/sample-physics-module.pdf");
