// explore: displayed data and control values never reach the aria output.
import assert from "node:assert/strict";
import { test } from "node:test";
import { redactAria } from "../scripts/explore/redact.ts";

const TABLE = `- main:
  - heading "Customers" [level=1]
  - table:
    - rowgroup:
      - row "Name Email":
        - columnheader "Name"
        - columnheader "Email"
    - rowgroup:
      - row "Ada Lovelace ada@example.com":
        - cell "Ada Lovelace":
          - link "Ada Lovelace":
            - /url: /customers/17
        - cell "ada@example.com"
      - row "Bob Stone bob@example.com":
        - cell "Bob Stone"
        - cell:
          - text: bob@example.com`;

test("table data is hidden, headers kept", () => {
  const { text, counts } = redactAria(TABLE);
  assert.match(text, /columnheader "Name"/);
  assert.match(text, /row "Name Email"/);
  assert.match(text, /heading "Customers" \[level=1\]/);
  assert.doesNotMatch(text, /Ada|Bob|example\.com|\/customers\/17/);
  assert.match(text, /row "…"/);
  assert.match(text, /cell "…"/);
  assert.match(text, /link "…"/);
  assert.equal(counts.rows, 2);
  assert.equal(counts.cells, 4);
});

test("control values are removed", () => {
  const { text, counts } = redactAria(`- form "New customer":
  - textbox "Email": ada@example.com
  - textbox "Note": hello note
  - combobox "Country": France
  - combobox "Size":
    - option "Small"
    - option "Large" [selected]
  - checkbox "VIP" [checked]
  - button "Save"`);
  assert.match(text, /- textbox "Email"$/m);
  assert.doesNotMatch(text, /ada@example\.com|hello note|France/);
  // The chosen option and the checked state are values too.
  assert.match(text, /option "Large"$/m);
  assert.match(text, /checkbox "VIP"$/m);
  assert.equal(counts.values, 5);
});

const items = (n: number, parent: string) =>
  `- ${parent}:
  - list:
${Array.from({ length: n }, (_, i) => `    - listitem:
      - link "Order ${1000 + i}":
        - /url: /orders/${i}`).join("\n")}`;

test("repeated list items in main are hidden", () => {
  const four = redactAria(items(4, "main"));
  assert.doesNotMatch(four.text, /Order 10|\/orders\//);
  assert.equal(four.counts.items, 4);
  assert.match(redactAria(items(3, "main")).text, /Order 1002/);
  assert.match(redactAria(items(4, "navigation")).text, /Order 1003/);
});

test("select options kept, custom listbox options and definitions hidden", () => {
  const { text } = redactAria(`- main:
  - combobox "Country":
    - option "France"
  - listbox "Customers":
    - option "Ada Lovelace"
  - term: Phone
  - definition: 555-1234`);
  assert.match(text, /option "France"/);
  assert.doesNotMatch(text, /Ada|555/);
  assert.match(text, /term: Phone/);
  assert.match(text, /definition: …/);
});

test("non-ASCII names outside data are kept", () => {
  const input = `- main:
  - heading "Müşteriler" [level=1]
  - button "Ödeme"
  - paragraph: Çok güzel`;
  assert.equal(redactAria(input).text, input);
});

test("quoted names with escaped quotes are parsed", () => {
  const { text } = redactAria(`- table:
  - row "Say \\"hi\\" Ada":
    - cell "Say \\"hi\\" Ada"`);
  assert.doesNotMatch(text, /Ada|hi/);
});

test("record pages hide their main heading", () => {
  const input = `- main:
  - heading "Ada Lovelace" [level=1]
  - heading "Contact" [level=2]`;
  const { text } = redactAria(input, { recordPage: true });
  assert.doesNotMatch(text, /Ada/);
  assert.match(text, /heading "…" \[level=1\]/);
  assert.match(text, /heading "Contact" \[level=2\]/);
  assert.match(redactAria(input).text, /Ada Lovelace/);
});

test("a value printed as a text child of a control is removed", () => {
  const { text, counts } = redactAria(`- textbox "Email":
  - /placeholder: name@company.com
  - text: ada@example.com`);
  assert.doesNotMatch(text, /ada@example\.com/);
  assert.match(text, /\/placeholder: name@company\.com/);
  assert.equal(counts.values, 1);
});

test("selected options, checked states and rich text are removed", () => {
  const { text } = redactAria(`- form "Edit customer":
  - combobox "Country":
    - option "France"
    - option "Germany" [selected]
  - checkbox "VIP customer" [checked]
  - radio "Plan Gold" [checked]
  - switch "Active" [checked=mixed]
  - button "Bold" [pressed]
  - textbox "Body":
    - /placeholder: Write here
    - paragraph: Dear Ada, your balance
  - button "Save"`);
  assert.match(text, /option "Germany"$/m);
  assert.doesNotMatch(text, /\[selected\]|\[checked|\[pressed\]|Dear Ada|paragraph/);
  assert.match(text, /\/placeholder: Write here/);
  assert.match(text, /checkbox "VIP customer"$/m);
});

test("lists are hidden without a main landmark, outside navigation", () => {
  const four = (parent: string) => `- ${parent}:
  - list:
${[1, 2, 3, 4].map((i) => `    - listitem: Customer ${i}`).join("\n")}`;
  assert.doesNotMatch(redactAria(`- generic:\n  - heading "Customers" [level=1]\n${four("generic").replace(/^/gm, "  ")}`).text, /Customer \d/);
  assert.match(redactAria(`- main:\n  - heading "x"\n${four("navigation").replace(/^/gm, "  ")}`).text, /Customer 4/);
});

test("a list with one odd item is still hidden", () => {
  const { text } = redactAria(`- main:
  - list:
    - listitem:
      - link "Ada Lovelace"
    - listitem:
      - link "Grace Hopper"
      - img "VIP"
    - listitem:
      - link "Alan Turing"
    - listitem:
      - link "Edsger Dijkstra"`);
  assert.doesNotMatch(text, /Ada|Grace|Alan|Edsger/);
});
