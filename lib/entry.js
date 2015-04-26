"use strict";

var PassThrough = require("stream").PassThrough,
	zlib = require("zlib")
	;

var STORE = 0x00,
	DEFLATE = 0x08
	;
	
var Entry = module.exports = function(fields) {
	this._stream = null;
	
	for(var field in fields) {
		this[field] = fields[field];
	}
}

Entry.prototype.stream = function() {
	if(this._stream) {
		return this._stream;
	}
	
	switch(this.compressionMethod) {
		case STORE: this._stream = new PassThrough(); break;
		case DEFLATE: this._stream = zlib.createInflateRaw(); break;
		default:
			console.warn("unsupported compression method");
			this._stream = new PassThrough();
	}
	return this._stream;
}

Entry.prototype.isStreamable = function() {
	return !!this._stream;
}