/**
 * test_parser.js - Offline Test Harness for Mostaql Job Parser
 * 
 * Usage:
 *   node test_parser.js [path_to_custom_html_file]
 * 
 * Example:
 *   node test_parser.js sample_mostaql.html
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { parseJobsFromHTML, parseJobsWithRegex } from './parser.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Target file from CLI arg or default sample
const targetFile = process.argv[2] 
  ? path.resolve(process.cwd(), process.argv[2]) 
  : path.join(__dirname, 'sample_mostaql.html');

console.log('='.repeat(60));
console.log(' Mostaql HTML Parser Test Harness');
console.log('='.repeat(60));
console.log(`Reading HTML from: ${targetFile}\n`);

if (!fs.existsSync(targetFile)) {
  console.error(`Error: File not found at ${targetFile}`);
  process.exit(1);
}

const htmlContent = fs.readFileSync(targetFile, 'utf-8');
console.log(`File Size: ${(htmlContent.length / 1024).toFixed(2)} KB\n`);

// 1. Test with simple DOM simulation or Regex
let jobs = [];

// If jsdom or any DOMParser is present or in browser environment:
if (typeof DOMParser !== 'undefined') {
  jobs = parseJobsFromHTML(htmlContent, DOMParser);
} else {
  // Try dynamic import of jsdom if installed, otherwise run regex fallback
  try {
    const { JSDOM } = await import('jsdom');
    const dom = new JSDOM(htmlContent);
    const { parseJobsFromDOM } = await import('./parser.js');
    jobs = parseJobsFromDOM(dom.window.document);
    console.log('[Mode: Full DOM Document]');
  } catch {
    console.log('[Mode: Regex / Pure JS Fallback (jsdom not in package)]');
    jobs = parseJobsWithRegex(htmlContent);
  }
}

console.log(`Successfully parsed ${jobs.length} project(s):\n`);

jobs.forEach((job, index) => {
  console.log(`[Job #${index + 1}]`);
  console.log(`  ID:          ${job.id}`);
  console.log(`  Title:       ${job.title}`);
  console.log(`  URL:         ${job.url}`);
  console.log(`  Budget:      ${job.budget}`);
  console.log(`  Time:        ${job.postedTime}`);
  console.log(`  Category:    ${job.category}`);
  if (job.description) {
    console.log(`  Description: ${job.description.slice(0, 100)}...`);
  }
  console.log('-'.repeat(60));
});

console.log(`\nSummary: ${jobs.length} projects successfully extracted.`);
