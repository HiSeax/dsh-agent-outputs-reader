/* 生成测试样本：minimal 合法 PDF + 手工 stored-zip 的 docx/xlsx，写入 sent-files。 */
const fs = require('node:fs')
const path = require('node:path')
const sent = 'C:/Users/xiao/.dsh/sent-files'

function crc32(buf) {
  const table = []
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1)
    table[n] = c >>> 0
  }
  let c = 0xffffffff
  for (const b of buf) c = table[(c ^ b) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function makeStoredZip(entries) {
  const locals = []
  const centrals = []
  let offset = 0
  for (const e of entries) {
    const name = Buffer.from(e.name, 'utf8')
    const data = Buffer.from(e.data, 'utf8')
    const crc = crc32(data)
    const lh = Buffer.alloc(30)
    lh.writeUInt32LE(0x04034b50, 0)
    lh.writeUInt16LE(20, 4)
    lh.writeUInt32LE(crc, 14)
    lh.writeUInt32LE(data.length, 18)
    lh.writeUInt32LE(data.length, 22)
    lh.writeUInt16LE(name.length, 26)
    const ch = Buffer.alloc(46)
    ch.writeUInt32LE(0x02014b50, 0)
    ch.writeUInt16LE(20, 4)
    ch.writeUInt16LE(20, 6)
    ch.writeUInt32LE(crc, 16)
    ch.writeUInt32LE(data.length, 20)
    ch.writeUInt32LE(data.length, 24)
    ch.writeUInt16LE(name.length, 28)
    ch.writeUInt32LE(offset, 42)
    locals.push(Buffer.concat([lh, name, data]))
    centrals.push(Buffer.concat([ch, name]))
    offset += 30 + name.length + data.length
  }
  const cd = Buffer.concat(centrals)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(entries.length, 8)
  eocd.writeUInt16LE(entries.length, 10)
  eocd.writeUInt32LE(cd.length, 12)
  eocd.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, cd, eocd])
}

/* 最小合法 PDF（offset 精确计算） */
function makePdf() {
  const objects = [
    '<</Type/Catalog/Pages 2 0 R>>',
    '<</Type/Pages/Kids[3 0 R]/Count 1>>',
    '<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>',
    null, // stream object, 后续填充
    '<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>',
  ]
  const stream = 'BT /F1 24 Tf 100 700 Td (Agent Outputs Reader - PDF OK) Tj ET'
  let pdf = '%PDF-1.4\n'
  const offsets = []
  for (let i = 0; i < objects.length; i++) {
    const idx = i + 1
    offsets.push(pdf.length)
    if (idx === 4) {
      pdf += '4 0 obj<</Length ' + Buffer.byteLength(stream) + '>>stream\n' + stream + '\nendstream endobj\n'
    } else {
      pdf += idx + ' 0 obj' + objects[i] + 'endobj\n'
    }
  }
  const xrefPos = pdf.length
  pdf += 'xref\n0 ' + (objects.length + 1) + '\n'
  pdf += '0000000000 65535 f \n'
  for (const off of offsets) pdf += String(off).padStart(10, '0') + ' 00000 n \n'
  pdf += 'trailer<</Size ' + (objects.length + 1) + '/Root 1 0 R>>\nstartxref\n' + xrefPos + '\n%%EOF'
  return Buffer.from(pdf, 'latin1')
}

const docx = makeStoredZip([{
  name: 'word/document.xml',
  data: '<?xml version="1.0"?><w:document xmlns:w="x"><w:body>'
    + '<w:p><w:r><w:t>DOCX 测试成功</w:t></w:r></w:p>'
    + '<w:p><w:r><w:t>第二段内容</w:t></w:r></w:p>'
    + '</w:body></w:document>',
}])
const xlsx = makeStoredZip([
  {
    name: 'xl/sharedStrings.xml',
    data: '<?xml version="1.0"?><sst xmlns="x"><si><t>指标</t></si><si><t>数值</t></si></sst>',
  },
  {
    name: 'xl/worksheets/sheet1.xml',
    data: '<?xml version="1.0"?><worksheet xmlns="x"><sheetData>'
      + '<row><c t="s"><v>0</v></c><c t="s"><v>1</v></c></row>'
      + '<row><c t="s"><v>0</v></c><c><v>3.14</v></c></row>'
      + '</sheetData></worksheet>',
  },
])

fs.writeFileSync(path.join(sent, 'test-sample.pdf'), makePdf())
fs.writeFileSync(path.join(sent, 'test-sample.docx'), docx)
fs.writeFileSync(path.join(sent, 'test-sample.xlsx'), xlsx)
console.log('samples written:', fs.readdirSync(sent).filter((f) => f.startsWith('test-sample')).join(', '))
