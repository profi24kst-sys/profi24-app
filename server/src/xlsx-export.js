import {deflateRawSync} from 'node:zlib';

// Minimal XLSX writer: no third-party runtime dependency, no formulas or external links.
// Every imported value is emitted as a literal inline string or a finite number.
function xml(value){
  return String(value??'').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g,'')
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;').replace(/'/g,'&apos;');
}

function columnLetter(index){
  let n=index+1,result='';
  while(n>0){n--;result=String.fromCharCode(65+n%26)+result;n=Math.floor(n/26)}
  return result;
}

function sheetXml(columns,rows){
  const headers='<row r="1">'+columns.map((column,i)=>
    '<c r="'+columnLetter(i)+'1" s="1" t="inlineStr"><is><t>'+xml(column.header)+'</t></is></c>'
  ).join('')+'</row>';
  const body=rows.map((row,index)=>{
    const number=index+2;
    return '<row r="'+number+'">'+columns.map((column,i)=>{
      const coordinate=columnLetter(i)+number;
      const value=row[i];
      if(value==null||value==='')return '<c r="'+coordinate+'"/>';
      if(column.type==='number'&&typeof value==='number'&&Number.isFinite(value)){
        return '<c r="'+coordinate+'" t="n"><v>'+value+'</v></c>';
      }
      return '<c r="'+coordinate+'" t="inlineStr"><is><t xml:space="preserve">'+xml(value)+'</t></is></c>';
    }).join('')+'</row>';
  }).join('');
  const last=columnLetter(columns.length-1)+(rows.length+1);
  const widths='<cols>'+columns.map((c,i)=>'<col min="'+(i+1)+'" max="'+(i+1)+'" width="'+Math.min(70,Math.max(10,Number(c.width)||20))+'" customWidth="1"/>').join('')+'</cols>';
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'+
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'+
    '<dimension ref="A1:'+last+'"/><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>'+
    widths+'<sheetData>'+headers+body+'</sheetData><autoFilter ref="A1:'+last+'"/></worksheet>';
}

function crc32(buffer){
  let crc=0xffffffff;
  for(const byte of buffer){
    crc^=byte;
    for(let bit=0;bit<8;bit++)crc=(crc>>>1)^((crc&1)?0xedb88320:0);
  }
  return (crc^0xffffffff)>>>0;
}

function zip(files){
  const locals=[],central=[];
  let offset=0;
  const now=new Date(),year=Math.max(1980,now.getUTCFullYear());
  const time=(now.getUTCHours()<<11)|(now.getUTCMinutes()<<5)|(now.getUTCSeconds()>>1);
  const date=((year-1980)<<9)|((now.getUTCMonth()+1)<<5)|now.getUTCDate();
  for(const [name,data] of files){
    const filename=Buffer.from(name,'utf8'),raw=Buffer.from(data,'utf8');
    const compressed=deflateRawSync(raw),checksum=crc32(raw);
    const local=Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50,0);local.writeUInt16LE(20,4);local.writeUInt16LE(0,6);
    local.writeUInt16LE(8,8);local.writeUInt16LE(time,10);local.writeUInt16LE(date,12);
    local.writeUInt32LE(checksum,14);local.writeUInt32LE(compressed.length,18);local.writeUInt32LE(raw.length,22);
    local.writeUInt16LE(filename.length,26);
    locals.push(local,filename,compressed);
    const entry=Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50,0);entry.writeUInt16LE(20,4);entry.writeUInt16LE(20,6);
    entry.writeUInt16LE(0,8);entry.writeUInt16LE(8,10);entry.writeUInt16LE(time,12);
    entry.writeUInt16LE(date,14);entry.writeUInt32LE(checksum,16);
    entry.writeUInt32LE(compressed.length,20);entry.writeUInt32LE(raw.length,24);
    entry.writeUInt16LE(filename.length,28);entry.writeUInt32LE(offset,42);
    central.push(entry,filename);
    offset+=local.length+filename.length+compressed.length;
  }
  const directory=Buffer.concat(central);
  const footer=Buffer.alloc(22);
  footer.writeUInt32LE(0x06054b50,0);
  footer.writeUInt16LE(files.length,8);footer.writeUInt16LE(files.length,10);
  footer.writeUInt32LE(directory.length,12);footer.writeUInt32LE(offset,16);
  return Buffer.concat([...locals,directory,footer]);
}

export function xlsxBuffer({sheetName='Отчёт',columns,rows}){
  if(!Array.isArray(columns)||!columns.length||columns.length>30)throw new Error('Invalid workbook columns');
  if(!Array.isArray(rows)||rows.length>10000||rows.some(row=>!Array.isArray(row)))throw new Error('Workbook row limit exceeded');
  const name=String(sheetName).replace(/[\\/*?:[\]]/g,' ').slice(0,31)||'Отчёт';
  const types='<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'+
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'+
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'+
    '<Default Extension="xml" ContentType="application/xml"/>'+
    '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'+
    '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>'+
    '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>';
  const rels='<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'+
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'+
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>';
  const workbook='<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'+
    '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'+
    '<sheets><sheet name="'+xml(name)+'" sheetId="1" r:id="rId1"/></sheets></workbook>';
  const workbookRels='<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'+
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'+
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>'+
    '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>';
  const styles='<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'+
    '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'+
    '<fonts count="2"><font><sz val="11"/><name val="Aptos"/></font><font><b/><sz val="11"/><name val="Aptos"/></font></fonts>'+
    '<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>'+
    '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>'+
    '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>'+
    '<cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0"/></cellXfs></styleSheet>';
  return zip([
    ['[Content_Types].xml',types],['_rels/.rels',rels],
    ['xl/workbook.xml',workbook],['xl/_rels/workbook.xml.rels',workbookRels],
    ['xl/styles.xml',styles],['xl/worksheets/sheet1.xml',sheetXml(columns,rows)]
  ]);
}
