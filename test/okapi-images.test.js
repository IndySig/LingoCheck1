const test = require("node:test");
const assert = require("node:assert/strict");
const { parseXliff, resolveMergeTranslations, applyTranslationsToXliff } = require("../okapi");

const xliff = `<?xml version="1.0" encoding="UTF-8"?>
<xliff version="1.2">
  <file source-language="nl" target-language="nl">
    <body>
      <trans-unit id="tu1">
        <source>Nieuws uit de buurttuin met afbeeldingen</source>
        <seg-source><mrk mid="0" mtype="seg">Nieuws uit de buurttuin met afbeeldingen</mrk></seg-source>
      </trans-unit>
      <trans-unit id="tu2-sub1">
        <source>Picture 101_tuinplattegrond.png</source>
        <seg-source><mrk mid="0" mtype="seg">Picture 101_tuinplattegrond.png</mrk></seg-source>
      </trans-unit>
      <trans-unit id="tu2-sub2">
        <source>Picture 101_tuinplattegrond.png</source>
        <seg-source><mrk mid="0" mtype="seg">Picture 101_tuinplattegrond.png</mrk></seg-source>
      </trans-unit>
      <trans-unit id="tu3">
        <source>Afbeelding 1 De buurttuin met kas en perenboom</source>
        <seg-source><mrk mid="0" mtype="seg">Afbeelding 1 De buurttuin met kas en perenboom</mrk></seg-source>
      </trans-unit>
      <trans-unit id="tu4">
        <source>Een nieuwe plek voor de zadenkast</source>
        <seg-source><mrk mid="0" mtype="seg">Een nieuwe plek voor de zadenkast</mrk></seg-source>
      </trans-unit>
      <trans-unit id="tu5">
        <source>De kast is toegankelijk wanneer de tuin open is.</source>
        <seg-source><mrk mid="0" mtype="seg">De kast is toegankelijk wanneer de tuin open is.</mrk></seg-source>
      </trans-unit>
    </body>
  </file>
</xliff>`;

const visible = [
  "Nieuws uit de buurttuin met afbeeldingen",
  "Afbeelding 1 De buurttuin met kas en perenboom",
  "Een nieuwe plek voor de zadenkast",
  "De kast is toegankelijk wanneer de tuin open is."
];

test("image filenames are left out of the body text", function () {
  assert.deepEqual(parseXliff(xliff).sentences, visible);
});

test("separate paragraphs stay in their own boxes", function () {
  const aligned = resolveMergeTranslations(xliff, { fullText: visible.join("\n\n") });
  assert.deepEqual(aligned, visible);
});

test("a glued title drops the photo name and gives the caption its own box", function () {
  const fullText = [
    "Nieuws uit de buurttuin met afbeeldingen Picture 101_tuinplattegrond.png Afbeelding 1 De buurttuin met kas en perenboom Een nieuwe plek voor de zadenkast",
    "De kast is toegankelijk wanneer de tuin open is."
  ].join("\n\n");
  const aligned = resolveMergeTranslations(xliff, { fullText });
  assert.deepEqual(aligned, visible);
  assert.equal(aligned.some((part) => /Picture\s+101_/i.test(part)), false);
});

test("image name units are not overwritten with article text", function () {
  const out = applyTranslationsToXliff(xliff, ["Titel", "Bijschrift", "Kop", "Zin."]);
  const targets = [...out.matchAll(/<target\b[^>]*>([\s\S]*?)<\/target>/gi)].map((match) => match[1]);
  assert.equal(targets.length, 4);
  assert.match(targets[0], /Titel/);
  assert.match(targets[1], /Bijschrift/);
  assert.equal(targets.some((target) => /Picture\s+101_/i.test(target)), false);
  assert.match(out, /<source>Picture 101_tuinplattegrond\.png<\/source>/);
});
