const fs = require("fs");
const express = require("express");
const bodyParser = require("body-parser");
const expressLogging = require("express-logging");
const queryString = require("querystring");
const path = require("path");
const getPort = require("get-port");
const chokidar = require("chokidar");
// const chalk = require("chalk");
const {
  NETLIFYDEVLOG,
  // NETLIFYDEVWARN,
  NETLIFYDEVERR
} = require("netlify-cli-logo");

const { findModuleDir, findHandler } = require("./finders");

const defaultPort = 34567;

function handleErr(err, response) {
  response.statusCode = 500;
  response.write(
    `${NETLIFYDEVERR} Function invocation failed: ` + err.toString()
  );
  response.end();
  console.log(`${NETLIFYDEVERR} Error during invocation: `, err); // eslint-disable-line no-console
}

function createCallback(response) {
  return function(err, lambdaResponse) {
    if (err) {
      return handleErr(err, response);
    }

    response.statusCode = lambdaResponse.statusCode;
    // eslint-disable-line guard-for-in
    for (const key in lambdaResponse.headers) {
      response.setHeader(key, lambdaResponse.headers[key]);
    }
    response.write(
      lambdaResponse.isBase64Encoded
        ? Buffer.from(lambdaResponse.body, "base64")
        : lambdaResponse.body
    );
    response.end();
  };
}

function promiseCallback(promise, callback) {
  if (!promise) return;
  if (typeof promise.then !== "function") return;
  if (typeof callback !== "function") return;

  promise.then(
    function(data) {
      callback(null, data);
    },
    function(err) {
      callback(err, null);
    }
  );
}

// function getHandlerPath(functionPath) {
//   if (functionPath.match(/\.js$/)) {
//     return functionPath;
//   }

//   return path.join(functionPath, `${path.basename(functionPath)}.js`);
// }

function createHandler(dir) {
  const functions = {};
  fs.readdirSync(dir).forEach(file => {
    if (dir === "node_modules") {
      return;
    }
    const functionPath = path.resolve(path.join(dir, file));
    const handlerPath = findHandler(functionPath);
    if (!handlerPath) {
      return;
    }
    if (path.extname(functionPath) === ".js") {
      functions[file.replace(/\.js$/, "")] = {
        functionPath,
        moduleDir: findModuleDir(functionPath)
      };
    } else if (fs.lstatSync(functionPath).isDirectory()) {
      functions[file] = {
        functionPath: handlerPath,
        moduleDir: findModuleDir(functionPath)
      };
    }
  });

  Object.keys(functions).forEach(name => {
    const fn = functions[name];
    const clearCache = () => {
      const before = module.paths;
      module.paths = [fn.moduleDir];
      delete require.cache[require.resolve(fn.functionPath)];
      module.paths = before;
    };
    const pathsToWatch = [fn.functionPath];
    if (fn.moduleDir) {
      pathsToWatch.push(path.join(fn.moduleDir, "package.json"));
    }
    fn.watcher = chokidar.watch(pathsToWatch, {
      ignored: /node_modules/
    });
    fn.watcher
      .on("add", clearCache)
      .on("change", clearCache)
      .on("unlink", clearCache);
  });

  return function(request, response) {
    // handle proxies without path re-writes (http-servr)
    const cleanPath = request.path.replace(/^\/.netlify\/functions/, "");

    const func = cleanPath.split("/").filter(function(e) {
      return e;
    })[0];
    if (!functions[func]) {
      response.statusCode = 404;
      response.end("Function not found...");
      return;
    }
    const { functionPath, moduleDir } = functions[func];
    let handler;
    let before = module.paths;
    try {
      module.paths = [moduleDir];
      handler = require(functionPath);
      module.paths = before;
    } catch (error) {
      module.paths = before;
      handleErr(error, response);
      return;
    }

    const isBase64 =
      request.body &&
      !(request.headers["content-type"] || "").match(
        /text|application|multipart\/form-data/
      );
    const lambdaRequest = {
      path: request.path,
      httpMethod: request.method,
      queryStringParameters: queryString.parse(request.url.split(/\?(.+)/)[1]),
      headers: request.headers,
      body: isBase64
        ? Buffer.from(request.body.toString(), "utf8").toString("base64")
        : request.body,
      isBase64Encoded: isBase64
    };

    const callback = createCallback(response);
    const promise = handler.handler(lambdaRequest, {}, callback);
    promiseCallback(promise, callback);
  };
}

async function serveFunctions(settings) {
  const app = express();
  const dir = settings.functionsDir;
  const port = await getPort({
    port: assignLoudly(settings.port, defaultPort)
  });

  app.use(bodyParser.raw({ limit: "6mb" }));
  app.use(bodyParser.text({ limit: "6mb", type: "*/*" }));
  app.use(
    expressLogging(console, {
      blacklist: ["/favicon.ico"]
    })
  );

  app.get("/favicon.ico", function(req, res) {
    res.status(204).end();
  });
  app.all("*", createHandler(dir));

  app.listen(port, function(err) {
    if (err) {
      console.error(`${NETLIFYDEVERR} Unable to start lambda server: `, err); // eslint-disable-line no-console
      process.exit(1);
    }

    // add newline because this often appears alongside the client devserver's output
    console.log(`\n${NETLIFYDEVLOG} Lambda server is listening on ${port}`); // eslint-disable-line no-console
  });

  return Promise.resolve({
    port
  });
}

module.exports = { serveFunctions };

// if first arg is undefined, use default, but tell user about it in case it is unintentional
function assignLoudly(
  optionalValue,
  fallbackValue,
  tellUser = dV =>
    console.log(`${NETLIFYDEVLOG} No port specified, using defaultPort of `, dV) // eslint-disable-line no-console
) {
  if (fallbackValue === undefined) throw new Error("must have a fallbackValue");
  if (fallbackValue !== optionalValue && optionalValue === undefined) {
    tellUser(fallbackValue);
    return fallbackValue;
  }
  return optionalValue;
}
