"use strict";

var binary = require("binary"),
	BufferList = require("bl"),
	iconv = require("iconv-lite")
	;

var DATA = 0,
	SIGNATURE = 1,
	FILENAME_LFH = 2,
	FILENAME_CDFH = 3,
	LFH = 0x04034b50,	//LocalFileHeader
	DD = 0x08074b50,	//DataDescriptor
	CDFH = 0x02014b50,	//CentralDirectoryFileHeader
	EOCDR = 0x06054b50	//EndOfCentralDirectoryRecord
	;
	
var sizes = { };
sizes[SIGNATURE] = 4;
//sizes of headers without signatures
sizes[LFH] = 26;
sizes[DD] = 12 ;
sizes[CDFH] = 42;
sizes[EOCDR] = 18;

	
var Parser = module.exports = function() {
	if(!(this instanceof Parser)) {
		return new Parser();
	}
	
	this.nextSize = 4;
	this.nextType = SIGNATURE; //starts with LocalFileHeader
	
	this.entries = [ ];
	this.entry = null;
		
	this.buffer = new BufferList();
}

Parser.prototype.parseChunk = function(chunk, callback) {
	var header, fileName;
	
	this.buffer.append(chunk);
	
	//skip signature, string, header parsing until get needed size
	if(this.nextType !== DATA && this.buffer.length < this.nextSize) {
		return callback();
	}
	
	while(this.buffer.length >= this.nextSize || (this.buffer.length && this.nextType === DATA)) {
		switch(this.nextType) {
			case SIGNATURE:
				this.nextType = this.buffer.readUInt32LE(0);
				this.buffer.consume(this.nextSize);
				this.nextSize = sizes[this.nextType];
				break;
				
			case LFH:
				this.entry = this.parseHeader(this.nextType, this.buffer.slice(0, this.nextSize));
				this.buffer.consume(this.nextSize);
				this.nextType = FILENAME_LFH;
				this.nextSize = this.entry.fileNameLength;
				break;
				
			case DD:
				header = this.parseHeader(this.nextType, this.buffer.slice(0, this.nextSize));
				this.entry.crc32 = header.crc32;
				this.entry.compressedSize = header.compressedSize;
				this.entry.uncompressedSize = header.uncompressedSize;
				
				this.buffer.consume(this.nextSize);
				this.nextType = DATA;
				this.nextSize = this.entry.compressionMethod === 8 ? 
					header.compressedSize : header.uncompressedSize;
				break;
			
			case CDFH:
				header = this.parseHeader(this.nextType, this.buffer.slice(0, this.nextSize));
				this.buffer.consume(this.nextSize);
				this.nextType = FILENAME_CDFH;
				this.nextSize = header.fileNameLength;
				break;
				
			case EOCDR:
				console.log(this.entries);
				return callback();
			
			case FILENAME_LFH:
				this.entry.fileName = this.parseString(this.entry.flags, this.buffer.slice(0, this.nextSize));
				
				//skip extra field
				this.buffer.consume(this.entry.fileNameLength + this.entry.extraFieldLength);
				
				//if bit 3 of the general purpose flag is set then file size is unknown
				//and we should parse data descriptor
				if(this.entry.flags & 0x08) {
					this.nextType = DD;
					this.nextSize = sizes[this.nextType];
				}
				else {
					this.nextType = DATA;
					this.nextSize = this.entry.compressionMethod === 8 ? 
						this.entry.compressedSize : this.entry.uncompressedSize;
				}
				break;
			
			case FILENAME_CDFH:
				fileName = this.parseString(header.flags, this.buffer.slice(0, this.nextSize));	
				this.entries[fileName].internalFileAttributes = header.internalFileAttributes;
				this.entries[fileName].externalFileAttributes = header.externalFileAttributes;
				
				//skip extra field and comments
				this.buffer.consume(header.fileNameLength + header.extraFieldLength + header.fileCommentLength);
				this.nextType = SIGNATURE;
				this.nextSize = sizes[this.nextType];
				break;
			
			case DATA:
				if(this.nextSize > this.buffer.length) {
					this.nextSize -= this.buffer.length;
					this.buffer.consume(this.buffer.length);
				}
				else {
					this.entries[this.entry.fileName] = this.entry;
					this.entry = null;
					this.buffer.consume(this.nextSize);
					this.nextType = SIGNATURE;
					this.nextSize = sizes[this.nextType];
				}
				break;
		}
	}
	callback();
}

Parser.prototype.parseString = function(flags, data) {
	//if bit 11 of the general purpose flag is set then encoding is utf-8, else ibm437
	return flags & 0x0800
		? data.toString("utf8")
		: iconv.decode(data, "ibm437")
}

Parser.prototype.parseHeader = function(signature, data) {
	switch(signature) {
		case LFH: return binary.parse(data)
			.word16lu("versionToExtract")
			.word16lu("flags")
			.word16lu("compressionMethod")
			.word16lu("modificationTime")
			.word16lu("modificationDate")
			.word32lu("crc32")
			.word32lu("compressedSize")
			.word32lu("uncompressedSize")
			.word16lu("fileNameLength")
			.word16lu("extraFieldLength")
			.vars;
			
		case DD: return binary.parse(data)
			.word16lu("crc32")
			.word16lu("compressedSize")
			.word16lu("uncompressedSize")
			.vars;
			
		case CDFH: return binary.parse(data)
			.word16lu("versionMadeBy")
			.word16lu("versionToExtract")
			.word16lu("flags")
			.word16lu("compressionMethod")
			.word16lu("modificationTime")
			.word16lu("modificationDate")
			.word32lu("crc32")
			.word32lu("compressedSize")
			.word32lu("uncompressedSize")
			.word16lu("fileNameLength")
			.word16lu("extraFieldLength")
			.word16lu("fileCommentLength")
			.word16lu("diskNumber")
			.word16lu("internalFileAttributes")
			.word32lu("externalFileAttributes")
			.word32lu("localFileHeaderOffset")
			.vars;
	}
}
