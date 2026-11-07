window.logs = [];
const log = console.log;
console.log = (...args) => {
  logs.push(args.join(' '));
  log(...args);
};

window.sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

window.report = (main) =>
  main()
    .catch((e) => ({ error: e.stack }))
    .then((out) => {
      document.getElementById('result').textContent = JSON.stringify({ ...out, logs });
    });
