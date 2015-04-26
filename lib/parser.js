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
	EOCDR = 0x06054b50,	//EndOfCentralDirectoryRecord,
	STORE = 0x00
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
	this._done = false;
	
	this._s = {
		nextSize: 4,
		nextType: SIGNATURE, //starts with LocalFileHeader
		entries: [ ],
		entry: null,
		buffer: new BufferList()
	}
}
inherits(Parser, EventEmitter);

Parser.prototype.parseChunk = function(chunk, callback) {
	var self = this,
		s = self._s,
		header, data
		;
	//fast skip unstreamable data
	if(s.nextType === DATA && !s.entry.isStreamable() && s.nextSize > chunk.length) {
		s.nextSize -= chunk.length;
		return callback();
	}
	
	s.buffer.append(chunk);
	
	//skip parsing until get needed size
	if(s.nextType !== DATA && s.buffer.length < s.nextSize) {
		return callback();
	}
	
	async.whilst(function test() {
		//buffer not empty and
		//can read next record or read data
		return s.buffer.length && 
			(s.buffer.length >= s.nextSize || (s.buffer.length && s.nextType === DATA));
	}, function parse(cb) {
		switch(s.nextType) {
			case SIGNATURE:
				s.nextType = s.buffer.readUInt32LE(0);
				s.buffer.consume(s.nextSize);
				s.nextSize = sizes[s.nextType];
				cb();
				break;
	
			case LFH:
				s.entry = new Entry(self._parseHeader(s.nextType, s.buffer.slice(0, s.nextSize)));
				s.buffer.consume(s.nextSize);
				s.nextType = LFH_END;
				s.nextSize = s.entry.raw.fileNameLength + s.entry.raw.extraFieldLength;
				cb();
				break;
				
			case LFH_END:
				s.entry.update({
					fileName: s.buffer.slice(0, s.entry.raw.fileNameLength),
					extraField: s.entry.raw.extraFieldLength
						? s.buffer.slice(s.entry.raw.fileNameLength, s.nextSize)
						: null
				});

				s.entries[s.entry.name] = s.entry;
				
				s.buffer.consume(s.nextSize);
				
				//if bit 3 of the general purpose flag is set then file size is unknown
				//and we should parse data descriptor
				if(s.entry.raw.flags & 0x08) {
					s.nextType = DD;
					s.nextSize = sizes[s.nextType];
					cb();
				}
				else {
					//skip data parsing for directories
					if(s.entry.isDirectory) {
						s.nextType = SIGNATURE;
						s.nextSize = sizes[s.nextType];
					}
					else {
						s.nextType = DATA;
						s.nextSize = s.entry.raw.compressionMethod === STORE ? 
							s.entry.raw.uncompressedSize : s.entry.raw.compressedSize;
					}
					
					self.emit("entry", s.entry);
					
					//wait for stream listeners
					process.nextTick(cb);
				}
				break;
				
			case DD:
				header = self._parseHeader(s.nextType, s.buffer.slice(0, s.nextSize));
				s.entry.update(header);
				
				s.buffer.consume(s.nextSize);
				s.nextType = DATA;
				s.nextSize = s.entry.raw.compressionMethod === STORE ? 
					header.uncompressedSize : header.compressedSize;
					
				self.emit("entry", s.entry);
				
				//wait for stream listeners
				process.nextTick(cb);
				break;
				
			case DATA:
				if(s.nextSize > s.buffer.length) {
					s.nextSize -= s.buffer.length;
					data = s.buffer.slice();
					s.buffer.consume(s.buffer.length);
					if(s.entry.isStreamable()) {
						s.entry.stream().write(data, cb);
					}
					else {
						cb();
					}
				}
				else {
					data = s.buffer.slice(0, s.nextSize);
					s.buffer.consume(s.nextSize);
					s.nextType = SIGNATURE;
					s.nextSize = sizes[s.nextType];
					if(s.entry.isStreamable()) {
						s.entry.stream().end(data, cb);
					}
					else {
						cb();
					}
				}
				break;			
			
			case CDFH:
				header = new Entry(self._parseHeader(s.nextType, s.buffer.slice(0, s.nextSize)));
				s.buffer.consume(s.nextSize);
				s.nextType = CDFH_END;
				s.nextSize = header.raw.fileNameLength + header.raw.extraFieldLength
					+ header.raw.commentLength;
				cb();
				break;
				
			case CDFH_END:
				header.update({
					fileName: s.buffer.slice(0, header.raw.fileNameLength),
					extraField: header.raw.extraFieldLength
						? s.buffer.slice(
							header.raw.fileNameLength,
							header.raw.fileNameLength + header.raw.extraFieldLength
						)
						: null,
					comment: s.buffer.slice(
						header.raw.fileNameLength + header.raw.extraFieldLength,
						s.nextSize
					)
				});
				
				//update entry with values from CDFH
				s.entries[header.name].update(header);
				
				s.buffer.consume(s.nextSize);
				
				s.nextType = SIGNATURE;
				s.nextSize = sizes[s.nextType];
				cb();
				break;
			
			case EOCDR:
				header = self._parseHeader(s.nextType, s.buffer.slice(0, s.nextSize));
				s.buffer.consume(s.nextSize);
				
				if(header.commentLength) {
					s.nextType = EOCDR_END;
					s.nextSize = header.commentLength;
					cb();
					break;
				}
				//empty comment
				//falling down
			
			case EOCDR_END:
				header.comment = header.commentLength
					? s.buffer.slice(0, header.commentLength)
					: null;
				
				self._done = true;
				self.emit("done", {
					entries: Object.keys(s.entries).map(function(entry) {
						return s.entries[entry];
					}),
					eocd: header
				});
				s.buffer.destroy();
				cb();
				break;
		}
	}, function done(err) {
		callback(err);
	});	
}

Parser.prototype.isDone = function() {
	return this._done;
}

Parser.prototype._parseHeader = function(signature, data) {
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
