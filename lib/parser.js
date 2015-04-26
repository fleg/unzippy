"use strict";

var binary = require("binary"),
	BufferList = require("bl"),
	iconv = require("iconv-lite"),
	inherits = require("util").inherits,
	async = require("async"),
	EventEmitter = require("events").EventEmitter,
	Entry = require("./entry.js")
	;

var DATA = 0,
	SIGNATURE = 1,
	LFH_END = 2,
	CDFH_END = 3,
	EOCDR_END = 4,
	LFH = 0x04034b50,	//LocalFileHeader
	DD = 0x08074b50,	//DataDescriptor
	CDFH = 0x02014b50,	//CentralDirectoryFileHeader
	EOCDR = 0x06054b50	//EndOfCentralDirectoryRecord
	;

var isDir = /[\/\\]$/;
	
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
inherits(Parser, EventEmitter);

Parser.prototype.parseChunk = function(chunk, callback) {
	var self = this,
		header, data
		;
	//fast skip unstreamable data
	if(self.nextType === DATA && !self.entry.isStreamable() && self.nextSize > chunk.length) {
		self.nextSize -= chunk.length;
		return callback();
	}
	
	self.buffer.append(chunk);
	
	//skip signature, string, header parsing until get needed size
	if(self.nextType !== DATA && self.buffer.length < self.nextSize) {
		return callback();
	}
	
	async.whilst(function test() {
		return self.buffer.length >= self.nextSize || (self.buffer.length && self.nextType === DATA);
	}, function parse(cb) {
		switch(self.nextType) {
			case SIGNATURE:
				self.nextType = self.buffer.readUInt32LE(0);
				self.buffer.consume(self.nextSize);
				self.nextSize = sizes[self.nextType];
				cb();
				break;
				
			case LFH:
				self.entry = new Entry(self.parseHeader(self.nextType, self.buffer.slice(0, self.nextSize)));
				self.buffer.consume(self.nextSize);
				self.nextType = LFH_END;
				self.nextSize = self.entry.fileNameLength + self.entry.extraFieldLength;
				cb();
				break;
				
			case DD:
				header = self.parseHeader(self.nextType, self.buffer.slice(0, self.nextSize));
				self.entry.crc32 = header.crc32;
				self.entry.compressedSize = header.compressedSize;
				self.entry.uncompressedSize = header.uncompressedSize;
				
				self.buffer.consume(self.nextSize);
				self.nextType = DATA;
				self.nextSize = self.entry.compressionMethod === 8 ? 
					header.compressedSize : header.uncompressedSize;
					
				self.emit("entry", self.entry);
				
				//wait for stream listeners
				process.nextTick(cb);
				break;
			
			case CDFH:
				header = self.parseHeader(self.nextType, self.buffer.slice(0, self.nextSize));
				self.buffer.consume(self.nextSize);
				self.nextType = CDFH_END;
				self.nextSize = header.fileNameLength + header.extraFieldLength + header.fileCommentLength;
				cb();
				break;
				
			case EOCDR:
				header = self.parseHeader(self.nextType, self.buffer.slice(0, self.nextSize));
				self.buffer.consume(self.nextSize);
				self.nextType = EOCDR_END;
				self.nextSize = header.commentLength;
				cb();
				break;
			
			case EOCDR_END:
				header.comment = self.parseString(0, self.buffer.slice(0, header.commentLength));
				self.emit("end", {
					entries: Object.keys(self.entries).map(function(entry) {
						return self.entries[entry];
					}),
					eocd: header
				});
				self.buffer.destroy();
				cb();
				break;
			
			case LFH_END:
				self.entry.fileName = self.parseString(self.entry.flags, self.buffer.slice(0, self.entry.fileNameLength));
				self.entry.extraField = self.entry.extraFieldLength
					? self.buffer.slice(self.entry.fileNameLength, self.nextSize)
					: null;

				self.entry.isDirectory = isDir.test(self.entry.fileName);
				self.entries[self.entry.fileName] = self.entry;
				
				self.buffer.consume(self.nextSize);
				
				//if bit 3 of the general purpose flag is set then file size is unknown
				//and we should parse data descriptor
				if(self.entry.flags & 0x08) {
					self.nextType = DD;
					self.nextSize = sizes[self.nextType];
					cb();
				}
				else {
					//skip data parsing for directories
					if(isDir.test(self.entry.fileName)) {
						self.nextType = SIGNATURE;
						self.nextSize = sizes[self.nextType];
					}
					else {
						self.nextType = DATA;
						self.nextSize = self.entry.compressionMethod === 8 ? 
							self.entry.compressedSize : self.entry.uncompressedSize;
					}
					
					self.emit("entry", self.entry);
					
					//wait for stream listeners
					process.nextTick(cb);
				}
				break;
			
			case CDFH_END:
				header.fileName = self.parseString(header.flags, self.buffer.slice(0, header.fileNameLength));
				header.extraField = header.extraFieldLength
					? self.buffer.slice(header.fileNameLength, header.fileNameLength + header.extraFieldLength)
					: null;
				header.comment = self.parseString(
					header.flags, self.buffer.slice(header.fileNameLength + header.extraFieldLength, self.nextSize)
				);
				
				//update entry with values from CDFH
				self.entries[header.fileName].update(header);
				
				self.buffer.consume(self.nextSize);
				
				self.nextType = SIGNATURE;
				self.nextSize = sizes[self.nextType];
				cb();
				break;
			
			case DATA:
				if(self.nextSize > self.buffer.length) {
					self.nextSize -= self.buffer.length;
					data = self.buffer.slice();
					self.buffer.consume(self.buffer.length);
					if(self.entry.isStreamable()) {
						self.entry.stream().write(data, cb);
					}
					else {
						cb();
					}
				}
				else {
					data = self.buffer.slice(0, self.nextSize);
					self.buffer.consume(self.nextSize);
					self.nextType = SIGNATURE;
					self.nextSize = sizes[self.nextType];
					if(self.entry.isStreamable()) {
						self.entry.stream().end(data, cb);
					}
					else {
						cb();
					}
				}
				break;
		}
	}, function done(err) {
		callback(err);
	});	
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
			
		case EOCDR: return binary.parse(data)
			.word16lu("diskNumber")
			.word16lu("startDiskNumber")
			.word16lu("numberCentralDirectoryRecord")
			.word16lu("totalCentralDirectoryRecord")
			.word32lu("sizeOfCentralDirectory")
			.word32lu("centralDirectoryOffset")
			.word16lu("commentLength")
			.vars;
	}
}
