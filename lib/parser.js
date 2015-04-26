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
	
	//skip parsing until get needed size
	if(self.nextType !== DATA && self.buffer.length < self.nextSize) {
		return callback();
	}
	
	async.whilst(function test() {
		//buffer not empty and
		//can read next record or read data
		return self.buffer.length && 
			(self.buffer.length >= self.nextSize || (self.buffer.length && self.nextType === DATA));
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
				self.nextSize = self.entry.raw.fileNameLength + self.entry.raw.extraFieldLength;
				cb();
				break;
				
			case LFH_END:
				self.entry.update({
					fileName: self.buffer.slice(0, self.entry.raw.fileNameLength),
					extraField: self.entry.raw.extraFieldLength
						? self.buffer.slice(self.entry.raw.fileNameLength, self.nextSize)
						: null
				});

				self.entries[self.entry.name] = self.entry;
				
				self.buffer.consume(self.nextSize);
				
				//if bit 3 of the general purpose flag is set then file size is unknown
				//and we should parse data descriptor
				if(self.entry.raw.flags & 0x08) {
					self.nextType = DD;
					self.nextSize = sizes[self.nextType];
					cb();
				}
				else {
					//skip data parsing for directories
					if(self.entry.isDirectory) {
						self.nextType = SIGNATURE;
						self.nextSize = sizes[self.nextType];
					}
					else {
						self.nextType = DATA;
						self.nextSize = self.entry.raw.compressionMethod === 8 ? 
							self.entry.raw.compressedSize : self.entry.raw.uncompressedSize;
					}
					
					self.emit("entry", self.entry);
					
					//wait for stream listeners
					process.nextTick(cb);
				}
				break;
				
			case DD:
				header = self.parseHeader(self.nextType, self.buffer.slice(0, self.nextSize));
				self.entry.update(header);
				
				self.buffer.consume(self.nextSize);
				self.nextType = DATA;
				self.nextSize = self.entry.raw.compressionMethod === 8 ? 
					header.compressedSize : header.uncompressedSize;
					
				self.emit("entry", self.entry);
				
				//wait for stream listeners
				process.nextTick(cb);
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
			
			case CDFH:
				header = new Entry(self.parseHeader(self.nextType, self.buffer.slice(0, self.nextSize)));
				self.buffer.consume(self.nextSize);
				self.nextType = CDFH_END;
				self.nextSize = header.raw.fileNameLength + header.raw.extraFieldLength + header.raw.commentLength;
				cb();
				break;
				
			case CDFH_END:
				header.update({
					fileName: self.buffer.slice(0, header.raw.fileNameLength),
					extraField: header.raw.extraFieldLength
						? self.buffer.slice(header.raw.fileNameLength, header.raw.fileNameLength + header.raw.extraFieldLength)
						: null,
					comment: self.buffer.slice(header.raw.fileNameLength + header.raw.extraFieldLength, self.nextSize)
				});
				
				//update entry with values from CDFH
				self.entries[header.name].update(header);
				
				self.buffer.consume(self.nextSize);
				
				self.nextType = SIGNATURE;
				self.nextSize = sizes[self.nextType];
				cb();
				break;
			
			case EOCDR:
				header = self.parseHeader(self.nextType, self.buffer.slice(0, self.nextSize));
				self.buffer.consume(self.nextSize);
				
				if(header.commentLength) {
					self.nextType = EOCDR_END;
					self.nextSize = header.commentLength;
					cb();
					break;
				}
				//empty comment
				//falling down
			
			case EOCDR_END:
				header.comment = header.commentLength
					? self.buffer.slice(0, header.commentLength)
					: null;

				self.emit("end", {
					entries: Object.keys(self.entries).map(function(entry) {
						return self.entries[entry];
					}),
					eocd: header
				});
				self.buffer.destroy();
				cb();
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
			.word16lu("commentLength")
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
