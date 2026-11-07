# 3D Inspector

ENOVIA(3DEXPERIENCE) 위젯 화면의 요소를 선택하면 그 요소를 만든 소스 모듈(`DS/...`)을 알려주는 크롬 개발자도구 확장입니다.

## 다운로드

[Releases](https://github.com/LeeOuHyoun/3d-inspector/releases/latest)에서 `3d-inspector-extension.zip`을 받아 압축을 풀면 `extension` 폴더가 나옵니다. 이 폴더를 크롬에 로드합니다.

> 저장소의 Code → Download ZIP으로 받은 소스는 빌드 전 상태라 그대로는 동작하지 않습니다.

## 사용법

[extension/README.md](extension/README.md)

## 개발

```
npm install
npm test
npm run build
```

`npm run build`는 `extension/`에 실행 파일을 만들고, `dist/3d-inspector.js`(콘솔 스니펫)를 생성합니다.
