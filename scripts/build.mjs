import { buildPackage } from "./package-lib.mjs";

const result = await buildPackage();
console.log(`Built ${result.filename} (${result.entries} source files)`);
console.log(`SHA-256 ${result.sha256}`);
