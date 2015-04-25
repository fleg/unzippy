"use strict";

var Transform = require("stream").Transform,
	inherits = require("util").inherits,
	Parser = require("./parser.js")
	;

	
var Unzippy = module.exports = function(options) {
	if(!(this instanceof Unzippy)) {
		return new Unzippy(options);
	}

	Transform.call(this, options);
	
	this._parser = new Parser();
}
inherits(Unzippy, Transform);

Unzippy.prototype._transform = function(chunk, encoding, callback) {
	this._parser.parseChunk(chunk, function() {
		callback();
	});
}
