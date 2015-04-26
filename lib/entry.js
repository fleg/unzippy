"use strict";

var PassThrough = require("stream").PassThrough,
	zlib = require("zlib"),
	convert = require("./convert.js")
	;

var STORE = 0x00,
	DEFLATE = 0x08
	;

var isDir = /[\/\\]$/;
	
var Entry = module.exports = function(raw) {
	this._stream = null;
	this.raw = { };
	this.update(raw);
}

Entry.prototype.update = function(fields) {
	var raw = fields instanceof Entry
		? fields.raw
		: fields;
	
	for(var field in raw) {
		this.raw[field] = raw[field];
	}
	
	if(raw.fileName) {
		this.name = convert.string(raw.fileName, this.raw.flags);
		this.isDirectory = isDir.test(this.name);
	}
	
	if(raw.modificationDate && raw.modificationTime) {
		this.date = convert.date(raw.modificationDate, raw.modificationTime);
	}
	
	if(raw.externalFileAttributes) {
		this.attributes = convert.attributes(raw.externalFileAttributes);
	}
}

Entry.prototype.stream = function() {
	if(this._stream) {
		return this._stream;
	}
	
	switch(this.raw.compressionMethod) {
		case STORE: this._stream = new PassThrough(); break;
		case DEFLATE: this._stream = zlib.createInflateRaw(); break;
		default:
			console.warn("unsupported compression method, pass stream without decompression");
			this._stream = new PassThrough();
	}
	return this._stream;
}

Entry.prototype.isStreamable = function() {
	return !!this._stream;
}
