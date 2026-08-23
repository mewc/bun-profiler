let total = 0;
const until = Date.now() + 120;
while (Date.now() < until) total += Math.sqrt(Math.random());
postMessage(total);
