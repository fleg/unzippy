"use strict";

var Unzippy = require("./lib/unzippy.js"),
	Parser = require("./lib/parser.js")
	;

function unzippy(options) {
	return new Unzippy(options);
}

unzippy.Unzippy = Unzippy;
unzippy.Parser = Parser;

module.exports = unzippy;