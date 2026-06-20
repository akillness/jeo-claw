with open("glue/server.ts", "r", encoding="utf-8") as f:
    code = f.read()

target = """  if ((res as any).artifacts) {
    advanced.artifacts = (res as any).artifacts;
  }"""

replacement = """  if ((res as any).artifacts) {
    advanced.artifacts = (res as any).artifacts;
  }
  if ((res as any).ciPassed === true) {
    advanced.ciPassed = true;
  }
  if ((res as any).reviewPassed === true) {
    advanced.reviewPassed = true;
  }"""

code = code.replace(target, replacement)

with open("glue/server.ts", "w", encoding="utf-8") as f:
    f.write(code)

print("patched")
