const fs = require("fs"),
  path = require("path"),
  cheerio = require("cheerio");

const tinify = require("tinify");
tinify.key = "mcVL6PpzY70kZbJFgqc24ZdXlkTfSJ9f";

function compressImg(url) {
  tinify.fromFile(url).toFile(path.join("dist", url));
}
fs.readFile(
  "./index.html",
  {
    flag: "r+",
    encoding: "utf8",
  },
  (err, buff) => {
    const UrlKey = "./images";
    const cssImageUrls = buff.matchAll(/url\((.+?)\)/gi);
    const cssImagePathUrls = [...cssImageUrls]
      .map((val) => val[1])
      .filter((val) => val.indexOf(UrlKey) !== -1);
    const $ = cheerio.load(buff, { ignoreWhitespace: true });
    const $imgs = $("img");
    $imgs.length &&
      $imgs.each((ind, tag) => {
        if (tag.attribs.src.indexOf(UrlKey) !== -1) {
          cssImagePathUrls.push(tag.attribs.src);
        }
      });
    new Set(cssImagePathUrls).forEach((path) => compressImg(path));
  }
);
