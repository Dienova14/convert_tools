import assert from "node:assert/strict";
import { buildDocumentTable } from "../assets/lib/document.js";
assert.equal(typeof buildDocumentTable, "function");
console.log("PASS header-regression import");
