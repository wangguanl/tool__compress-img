const fs = require("fs"),
  path = require("path"),
  cheerio = require("cheerio"),
  Sharp = require("sharp"),
  gulp = require("gulp"),
  // 压缩css
  sass = require("gulp-dart-sass"),
  postcss = require("gulp-postcss"),
  autoprefixer = require("autoprefixer"),
  cleanCSS = require("gulp-clean-css");

const config = {
  input: path.join(__dirname, "src2"),
  output: path.join(__dirname, "dist2"),
};
fs.readFile(
  path.join(config.input, "index.html"),
  {
    flag: "r+",
    encoding: "utf8",
  },
  async (err, buff) => {
    const $ = cheerio.load(buff, { ignoreWhitespace: true });
    // await pipeHTMLAttrDataOrigin($);
    // await pipeCss($);
    // await pipeImg($);
    copyImg($);
  }
);
function pipeHTMLAttrDataOrigin($) {
  return new Promise(async (resolve) => {
    const camelCaseToHyphen = (str) =>
      str.replace(/([a-z])([A-Z])/g, "$1-$2").toLowerCase();
    if ($("[data-original]").length) {
      const tagStyles = {};
      await Promise.all(
        $("[data-original]").map(
          (ind, tag) =>
            new Promise(async (resolve) => {
              const imgUrl = tag.attribs["data-original"];
              // console.log(imgUrl);
              const { height } = await sharpImg(imgUrl);
              const tagKey = "tag-key-" + Math.ceil(Math.random() * 1000000);
              tagStyles[tagKey] = {
                height: height + "px",
                // backgroundImage: `url(${imgUrl})`,
              };
              $(`[data-original=${imgUrl}]`).attr(tagKey, "");
              resolve();
            })
        )
      );
      // console.log(tagStyles);
      let css = "";
      for (let tagKey in tagStyles) {
        css += `[${tagKey}] {${Object.keys(tagStyles[tagKey])
          .map((key) => camelCaseToHyphen(key) + ":" + tagStyles[tagKey][key])
          .join(";")}}`;
      }
      $("head").append(`<style>${css}</style>`);
    }
    fs.writeFile(path.join(config.output, "index.html"), $.html(), (err) =>
      resolve()
    );
    // fs.writeFile("./dist/index.css", css, (err) => err);
  });
}
function copyImg($) {
  const $imgs = $("img");
  $imgs.length &&
    $imgs.each(async (ind, tag) => {
      const fileCont = await fs.promises.readFile(
        path.join(config.input, tag.attribs.src),
        "utf-8"
      );
      await fs.promises.writeFile(
        path.join(config.output, tag.attribs.src),
        fileCont,
        {
          encoding: "utf-8",
          flag: "w",
        }
      );
    });
}
function pipeImg($) {
  const $imgs = $("img");
  $imgs.length &&
    $imgs.each(async (ind, tag) => await sharpImg(tag.attribs.src));
}
function pipeCss($) {
  const $links = $("link");
  if (!$links.length) {
    return;
  }
  $links
    .filter((ind, tag) =>
      [".css", ".scss"].some((val) => val === path.extname(tag.attribs.href))
    )
    .map((ind, tag) => {
      const filePath = path.join(__dirname, "src", tag.attribs.href);
      if (fs.existsSync(filePath)) {
        gulp
          .src(filePath)
          .pipe(sass().on("error", sass.logError)) // sass编译
          .pipe(
            postcss([
              autoprefixer([
                "last 9 versions",
                "ie >= 6", //ie6以上
                "firefox >= 8",
                "chrome >= 24",
                "Opera>=10",
              ]),
            ])
          )
          .pipe(cleanCSS())
          .pipe(gulp.dest(config.output));
      }
    });
}

function sharpImg(filePath) {
  return new Promise(async (resolve) => {
    const SharpImage = Sharp(path.join(config.input, filePath));

    // 获取图片元信息
    const ImgMeta = await SharpImage.metadata();
    // console.log(ImgMeta);
    const { format } = ImgMeta;

    //  压缩文件，解决orientation方向错误的问题，并生成图片Buffer
    const ImgBuffer = await SharpImage.rotate().toBuffer();
    //  压缩文件
    const ImgMinBuffer = await compressImg({
      buffer: ImgBuffer,
      mimetype: format,
    });
    // 二次压缩
    const ImgMiniBuffer = await compressImg({
      buffer: ImgMinBuffer,
      mimetype: format,
      min: 40,
    });
    await Sharp(ImgMiniBuffer).toFile(path.join(config.output, filePath));
    resolve(ImgMeta);
  });
}

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
