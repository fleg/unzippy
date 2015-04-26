"use strict";

var Writable = require("stream").Writable,
	inherits = require("util").inherits,
	Parser = require("./parser.js"),
	fs = require("fs"),
	mkdirp = require("mkdirp"),
	join = require("path").join,
	dirname = require("path").dirname,
	extend = require("extend"),
	CRC32Stream = require("crc32-stream"),
	async = require("async")
	;

var isWin = /^win/i.test(process.platform);
	
var Unzippy = module.exports = function(options) {
	if(!(this instanceof Unzippy)) {
		return new Unzippy(options);
	}
	Writable.call(this, options);
	
	var self = this;
	
	self._options = extend({
		dest: "./",
		chmod: true,
		crc32Check: true
	}, options);
	
	//disable chmod on windows platforms
	self._options.chmod = self._options.chmod && !isWin;
	
	self._parser = new Parser();
	self._entriesCount = 0;
	self._entriesTotal = 0;
	
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
						if(entry.raw.crc32 !== crc32.digest()) {
							self.emit("error", new Error("crc32 check fails"));
						}
					});
					stream = stream.pipe(crc32);
				}
				stream.pipe(fs.createWriteStream(dest).on("finish", function() {
					self._incEntries();
				}));
			});
		}
		else {
			self._incEntries();
		}
	});
		
	self._parser.on("done", function(info) {
		self._parserInfo = info;
		if(self._entriesCount === info.eocd.totalCentralDirectoryRecord) {
			//parser done and all entries streams finished
			self._onDone();
		}
		else {
			//save total entries and wait for entries streams 
			self._entriesTotal = info.eocd.totalCentralDirectoryRecord;
		}
	})
}
inherits(Unzippy, Writable);

Unzippy.prototype._write = function(chunk, encoding, callback) {
	this._parser.parseChunk(chunk, function() {
		callback();
	});
}

Unzippy.prototype._incEntries = function() {
	++this._entriesCount;
	if(this._parser.isDone() && this._entriesCount === this._entriesTotal) {
		this._onDone();
	}
}

Unzippy.prototype._onDone = function() {
	var self = this;
	
	if(!self._options.chmod) {
		return self.emit("done", self._parserInfo);
	}
	
	self._chmodEntries(function(err) {
		if(err) {
			self.emit("error", err);
		}
		else {
			self.emit("done", self._parserInfo);
		}
	});
	
	//TODO change file timestamps???
}

Unzippy.prototype._chmodEntries = function(callback) {
	var self = this;
	async.each(self._parserInfo.entries, function(entry, cb) {
		fs.chmod(join(self._options.dest, entry.name), cb);
	}, callback);
}