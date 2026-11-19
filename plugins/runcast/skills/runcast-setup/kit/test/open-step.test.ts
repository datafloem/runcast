// steps.open goes to a page of the app, under its base path.
import assert from "node:assert/strict";
import { test } from "node:test";
import { appUrl } from "../core/scenario.ts";

test("paths are resolved under the base URL's path", () => {
  assert.equal(appUrl("/customers", "https://example.com/app"), "https://example.com/app/customers");
  assert.equal(appUrl("/", "https://example.com/app/"), "https://example.com/app/");
  assert.equal(appUrl("customers?page=2", "http://localhost:3000"), "http://localhost:3000/customers?page=2");
  assert.equal(appUrl("https://other.example/x", "http://localhost:3000"), "https://other.example/x");
});
