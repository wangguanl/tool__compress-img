const fs = require("fs"),
  path = require("path"),
  tinify = require("tinify");
tinify.key = "6Mf5s28SQC8yHydFMtSFcdpDFswd0ssd";
var pathName = "./images";
// 找到目录
fs.readdir(pathName, function (err, files) {
  var dirs = [];
  // 递归目录
  (function iterator(i) {
    if (i == files.length) {
      // console.log(dirs);
      dirs.map((filePath) =>
        tinify.fromFile(pathName + "/" + filePath).toFile("./dist/" + filePath)
      );
      return;
    }
    fs.stat(path.join(pathName, files[i]), function (err, data) {
      if (data.isFile()) {
        dirs.push(files[i]);
      }
      iterator(i + 1);
    });
  })(0);
});
