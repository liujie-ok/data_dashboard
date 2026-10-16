/**
 * CSV 工具模块。
 * 支持带引号字段、字段内逗号、双引号转义、以及带引号字段中的换行。
 * 不依赖第三方 CSV 库；这里的 parseCSV 返回表头数组和二维字符串数组。
 */
(() => {
  'use strict';

  /** 解析 CSV 文本，并对表头数量与每行列数进行一致性检查。 */
  function parseCSV(text) {
    const rows = [];
    let row = [];
    let field = '';
    let quoted = false;
    // Excel 导出的 UTF-8 CSV 可能带 BOM，先移除，避免污染第一列表头。
    const input = String(text ?? '').replace(/^\uFEFF/, '');
    for (let i = 0; i < input.length; i++) {
      const ch = input[i];
      // quoted=true 时，逗号和换行属于字段内容，不作为分隔符处理。
      if (quoted) {
        if (ch === '"' && input[i + 1] === '"') {
          field += '"';
          i++;
        } else if (ch === '"') {
          quoted = false;
        } else {
          field += ch;
        }
      } else if (ch === '"' && field.length === 0) {
        quoted = true;
      } else if (ch === ',') {
        row.push(field);
        field = '';
      } else if (ch === '\n' || ch === '\r') {
        if (ch === '\r' && input[i + 1] === '\n') i++;
        row.push(field);
        field = '';
        if (row.some(value => value.trim() !== '')) {
          rows.push(row);
        }
        row = [];
      } else {
        field += ch;
      }
    }
    if (quoted) throw new Error('CSV 文件包含未闭合的双引号');
    if (field.length || row.length) {
      row.push(field);
      if (row.some(value => value.trim() !== '')) {
        rows.push(row);
      }
    }
    // 空文件或只有表头的文件无法用于绘图，直接给出清晰错误。
    if (rows.length < 2) throw new Error('CSV 至少需要一行表头和一行数据');

    const headers = rows[0].map((value, index) => value.trim() || `列 ${index + 1}`);
    // 每行字段数必须与表头一致，避免后续列索引错位。
    const dataRows = rows.slice(1).map((values, index) => {
      if (values.length !== headers.length) {
        throw new Error(`第 ${index + 2} 行有 ${values.length} 列，表头有 ${headers.length} 列`);
      }
      return values.map(value => value.trim());
    });
    return { headers, rows: dataRows };
  }

  /** 将字段转换为有限数字；空字符串、NaN、Infinity 等返回 null。 */
  function parseFiniteNumber(value) {
    if (value === null || value === undefined || String(value).trim() === '') {
      return null;
    }
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  }

  window.CsvUtils = { parseCSV, parseFiniteNumber };
})();
