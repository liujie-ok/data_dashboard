/* Small RFC-4180-style CSV parser (quoted commas, escaped quotes and newlines). */
(() => {
  'use strict';

  function parseCSV(text) {
    const rows = [];
    let row = [], field = '', quoted = false;
    const input = String(text ?? '').replace(/^\uFEFF/, '');
    for (let i = 0; i < input.length; i++) {
      const ch = input[i];
      if (quoted) {
        if (ch === '"' && input[i + 1] === '"') { field += '"'; i++; }
        else if (ch === '"') quoted = false;
        else field += ch;
      } else if (ch === '"' && field.length === 0) quoted = true;
      else if (ch === ',') { row.push(field); field = ''; }
      else if (ch === '\n' || ch === '\r') {
        if (ch === '\r' && input[i + 1] === '\n') i++;
        row.push(field); field = '';
        if (row.some(value => value.trim() !== '')) rows.push(row);
        row = [];
      } else field += ch;
    }
    if (quoted) throw new Error('CSV 文件包含未闭合的双引号');
    if (field.length || row.length) {
      row.push(field);
      if (row.some(value => value.trim() !== '')) rows.push(row);
    }
    if (rows.length < 2) throw new Error('CSV 至少需要一行表头和一行数据');

    const headers = rows[0].map((value, index) => value.trim() || `列 ${index + 1}`);
    const dataRows = rows.slice(1).map((values, index) => {
      if (values.length !== headers.length) {
        throw new Error(`第 ${index + 2} 行有 ${values.length} 列，表头有 ${headers.length} 列`);
      }
      return values.map(value => value.trim());
    });
    return { headers, rows: dataRows };
  }

  function parseFiniteNumber(value) {
    if (value === null || value === undefined || String(value).trim() === '') return null;
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  }

  window.CsvUtils = { parseCSV, parseFiniteNumber };
})();
