// 共享 ZIP 写入器 (store-only·无压缩) → base64, 无第三方库。
// 与 cloud.html 内联实现逐字一致, 抽出供 daopan.html(全服通) 等复用。
(function(){
  function _crc32(bytes){
    var c, crc=-1;
    if(!_crc32.tab){ _crc32.tab=[]; for(var n=0;n<256;n++){ c=n; for(var k=0;k<8;k++) c=(c&1)?(0xEDB88320^(c>>>1)):(c>>>1); _crc32.tab[n]=c>>>0; } }
    for(var i=0;i<bytes.length;i++) crc=_crc32.tab[(crc^bytes[i])&0xFF]^(crc>>>8);
    return (crc^-1)>>>0;
  }
  function _utf8(str){
    var out=[],p=0;
    for(var i=0;i<str.length;i++){
      var c=str.charCodeAt(i);
      if(c<128) out[p++]=c;
      else if(c<2048){ out[p++]=192|(c>>6); out[p++]=128|(c&63); }
      else if(c>=0xD800&&c<=0xDBFF){ var c2=str.charCodeAt(++i); var cp=0x10000+((c&0x3FF)<<10)+(c2&0x3FF); out[p++]=240|(cp>>18); out[p++]=128|((cp>>12)&63); out[p++]=128|((cp>>6)&63); out[p++]=128|(cp&63); }
      else { out[p++]=224|(c>>12); out[p++]=128|((c>>6)&63); out[p++]=128|(c&63); }
    }
    return out;
  }
  function _u16(n){ return [n&0xFF,(n>>8)&0xFF]; }
  function _u32(n){ return [n&0xFF,(n>>8)&0xFF,(n>>16)&0xFF,(n>>24)&0xFF]; }
  function _b64ToBytes(b64){
    var B="ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    if(!_b64ToBytes.L){ _b64ToBytes.L={}; for(var i=0;i<B.length;i++)_b64ToBytes.L[B.charAt(i)]=i; }
    var L=_b64ToBytes.L;
    var s=String(b64||"").replace(/[\r\n\t ]/g,"");
    var pad=s.indexOf("="); if(pad>=0) s=s.substring(0,pad);
    var out=[],n=s.length;
    for(var j=0;j<n;j+=4){
      var e0=L[s.charAt(j)],e1=L[s.charAt(j+1)],e2=L[s.charAt(j+2)],e3=L[s.charAt(j+3)];
      if(e0==null||e1==null)break;
      out.push((e0<<2)|(e1>>4));
      if(e2!=null)out.push(((e1&15)<<4)|(e2>>2));
      if(e3!=null)out.push(((e2&3)<<6)|e3);
    }
    return out;
  }
  function buildZipBase64(files){
    var local=[], central=[], offset=0;
    files.forEach(function(f){
      var nameBytes=_utf8(f.name);
      var dataBytes=(f.b64!=null)?_b64ToBytes(f.b64):_utf8(f.data==null?"":String(f.data));
      var crc=_crc32(dataBytes);
      var lh=[].concat(_u32(0x04034b50),_u16(20),_u16(0x0800),_u16(0),_u16(0),_u16(0),_u32(crc),_u32(dataBytes.length),_u32(dataBytes.length),_u16(nameBytes.length),_u16(0),nameBytes,dataBytes);
      var ch=[].concat(_u32(0x02014b50),_u16(20),_u16(20),_u16(0x0800),_u16(0),_u16(0),_u16(0),_u32(crc),_u32(dataBytes.length),_u32(dataBytes.length),_u16(nameBytes.length),_u16(0),_u16(0),_u16(0),_u16(0),_u32(0),_u32(offset),nameBytes);
      local.push(lh); central.push(ch); offset+=lh.length;
    });
    var localFlat=[]; local.forEach(function(a){ localFlat=localFlat.concat(a); });
    var centralFlat=[]; central.forEach(function(a){ centralFlat=centralFlat.concat(a); });
    var eocd=[].concat(_u32(0x06054b50),_u16(0),_u16(0),_u16(files.length),_u16(files.length),_u32(centralFlat.length),_u32(localFlat.length),_u16(0));
    var all=localFlat.concat(centralFlat).concat(eocd);
    var b="";
    var B="ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    for(var i=0;i<all.length;i+=3){
      var a0=all[i],a1=all[i+1],a2=all[i+2];
      var n=(a0<<16)|((a1||0)<<8)|(a2||0);
      b+=B[(n>>18)&63]+B[(n>>12)&63]+(i+1<all.length?B[(n>>6)&63]:"=")+(i+2<all.length?B[n&63]:"=");
    }
    return b;
  }
  window.DaoZip = { buildZipBase64: buildZipBase64 };
  if(!window.buildZipBase64) window.buildZipBase64 = buildZipBase64;
})();
