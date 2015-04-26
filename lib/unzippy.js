"use strict";

var Writable = require("stream").Writable,
	inherits = require("util").inherits,
	Parser = require("./parser.js"),
	fs = require("fs"),
	mkdirp = require("mkdirp"),
	join = require("path").join,
	dirname = require("path").dirname,
	extend = require("extend"),
	CRC32Stream = require("crc32-stream");
	;

	
var Unzippy = module.exports = function(options) {
	if(!(this instanceof Unzippy)) {
		return new Unzippy(options);
	}
	
	var self = this;
	
	options = extend({
		dest: "./",
		chmod: true,	//TODO call fs.chmod(entry.externalFileAttributes) for each entry
		crc32Check: true//TODO crc32 check each entry
	}, options);
	
	Writable.call(self, options);
	
	self._parser = new Parser();
	
	self._parser.on("entry", function(entry) {
		var dest = join(options.dest, entry.name),
			stream = entry.stream(),
			crc32
			;
		
		if(!entry.isDirectory) {
			mkdirp(dirname(dest), function(err) {
				if(options.crc32Check) {
					crc32 = new CRC32Stream();
					crc32.on("end", function(err) {
						//TODO
						//console.log(entry.crc32, crc32.digest());
					});
					stream = stream.pipe(crc32);
				}
				stream.pipe(fs.createWriteStream(dest).on("finish", function() {
					//TODO
				}));
			});
		}
	});
		
	self._parser.on("end", function(info) {
		//TODO
	})
}
inherits(Unzippy, Writable);

Unzippy.prototype._write = function(chunk, encoding, callback) {
	this._parser.parseChunk(chunk, function() {
		callback();
	});
}
