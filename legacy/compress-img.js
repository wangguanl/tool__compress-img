const Sharp = require("sharp"),
  fs = require("fs"),
  path = require("path");
sharpImg();
/* 
	处理图片
	* 压缩
	* 旋转
	* 加水印
	* 裁剪
 */
function sharpImg() {
  var dirPath = "./images2";
  fs.readdir(dirPath, async (err, files) => {
    // console.log(files);
    files.forEach(async (filename) => {
      const SharpImage = Sharp(dirPath + "/" + filename);
      // 获取图片元信息
      const ImgMeta = await SharpImage.metadata();
      //  压缩文件，解决orientation方向错误的问题，并生成图片Buffer
      const ImgBuffer = await SharpImage.rotate().toBuffer();

      const ImgMinBuffer = await compressImg({
        buffer: ImgBuffer,
        mimetype: ImgMeta.format,
      });

      // 二次压缩
      const ImgMiniBuffer = await compressImg({
        buffer: ImgMinBuffer,
        mimetype: ImgMeta.format,
        min: 40,
      });

      Sharp(ImgMiniBuffer).toFile("./dist/compress-img2/" + filename); // 保存压缩水印图片
    });
  });
}

/*
 *压缩文件
 * file: 如果传入文件格式，则进行矫正压缩
 * buffer: 传入buffer则直接进行压缩
 * mimetype: 文件类型
 * min: 压缩质量，整数1-100（可选，默认80）
 * progressive： 渐进式压缩
 */
function compressImg({ buffer, mimetype, min = 80, progressive = false }) {
  const config = {
    jpg: {
      quality: min,
      progressive,
    },
    jpeg: {
      quality: min,
      progressive,
    },
    png: {
      compressionLevel: Math.ceil(min * 0.1),
      progressive,
    },
    webp: {
      quality: min,
      lossless: progressive, // 使用无损压缩模式（可选，默认false）
    },
  };
  return Sharp(buffer)[mimetype](config[mimetype]).toBuffer();
}
