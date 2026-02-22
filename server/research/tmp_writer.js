var fs = require("fs");
var existing = fs.readFileSync("server/research/eth_ml_final_val.js","utf8");
var code = existing;
code += "
";
code += "// candidates
";
fs.writeFileSync("server/research/eth_ml_final_val.js", code);
console.log("ok");