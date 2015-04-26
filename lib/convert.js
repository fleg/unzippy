"use strict";

var iconv = require("iconv-lite")
	;

var convert = module.exports = { };

convert.date = function(date, time) {
	date = date | 0;
	time = time | 0;
	
	return new Date(
		(date >> 9 & 0x7f) + 1980,	//y
		(date >> 5 & 0x0f) - 1,		//M
		date & 0x1f,				//d
		time >> 11 & 0x1f,			//h
		time >> 5 & 0x3f,			//m
		(time & 0x1f) << 1,			//s
		0
	);
}

convert.string = function(data, flags) {
	if(typeof flags !== "number") {
		flags = 0;
	}
	//if bit 11 of the general purpose flag is set then encoding is utf-8, else ibm437
	return flags & 0x0800
		? data.toString("utf8")
		: iconv.decode(data, "ibm437")
}

convert.attributes = function(attributes) {
	return attributes >> 16 & 0xffff;
}

