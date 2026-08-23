console.log("ready");
setInterval(() => {
  const until = Date.now() + 20;
  while (Date.now() < until) Math.sqrt(Math.random());
}, 30);
