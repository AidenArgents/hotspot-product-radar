const fs = require('fs');

const content = fs.readFileSync('C:/Users/LokiA/.gemini/antigravity/brain/a45d44d6-ffb8-4367-8d14-4022dbd0c29e/.system_generated/logs/transcript_full.jsonl', 'utf8');

const regex = /File Path: `file:\/\/\/d:\/Claude-Workspace\/hotspot-product-radar\/f\/radar\/collect_platform_intelligence.ts`.*?The above content shows the entire/s;
const match = content.match(regex);
if (match) {
  let str = match[0];
  str = str.replace(/\\n/g, '\n').replace(/\\r/g, '\r').replace(/\\"/g, '"');
  
  const lines = str.split('\n');
  const codeLines = [];
  for (const line of lines) {
    if (line.match(/^\d+: /)) {
      codeLines.push(line.replace(/^\d+: /, ''));
    }
  }
  let code = codeLines.join('\n');
  code = code.replace(/tavily\.ts/g, 'web_search.ts')
             .replace(/tavilySearch/g, 'searchWeb')
             .replace(/validateTavilyResults/g, 'validateSearchResults');
  fs.writeFileSync('d:/Claude-Workspace/hotspot-product-radar/f/radar/collect_platform_intelligence.ts', code, 'utf8');
  console.log('Restored!');
} else {
  console.log('Not found');
}