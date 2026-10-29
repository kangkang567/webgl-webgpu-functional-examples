/**
 * 功能简介: WebGL 多光源（光照数组）+ Phong 与 Blinn-Phong 高光对比
 * 作者: deepseek编写, wangweikang手动修改整理
 * 时间: 2026.10.29
 *
 * 操作:
 *   鼠标: 左键拖动=旋转观察, 右键拖动=平移, 滚轮=缩放, 双击=复位视角
 *   键盘: 1/2/3/4=开关对应光源  P=暂停/继续光源旋转  R=复位视角
 *
 * 知识点一: 多光源 = 把光照参数从「一个 vec3」升级成「一组 struct」, 在片元里循环累加。
 *   WebGL 靠名字里的下标查位置: 'uLights[0].position'、'uLights[1].position' …… 打包交给驱动;
 *   而「下标 → 位置」这件事在 WebGPU 里就是必须手工维护的字节偏移表:
 *
 *     | 数据                | WebGL 查法            | WebGPU 侧（数组元素按 16 字节对齐）  |
 *     | ------------------- | --------------------- | ----------------------------------- |
 *     | uLights[i].position | 'uLights[i].position' | base + i * 32 + 0  （vec3 对齐 16） |
 *     | uLights[i].color    | 'uLights[i].color'    | base + i * 32 + 16 （后补 4 字节）  |
 *
 *   vec3 只有 12 字节, 但在数组元素 / 结构体成员里必须按 16 字节对齐,
 *   所以每个 Light 实际占 32 字节, 12 个 float 里有 2 个是填充:
 *   WebGL 由驱动代劳, WebGPU 必须自己算, 算错就是「位置读到颜色」。
 *   （2_phonglight_webgpu.js 里那份 Uniforms 偏移表, 就是同一件事的单光源版本。）
 *
 * 知识点二: Phong 与 Blinn-Phong 只差「拿谁和法线点积」:
 *   Phong       : R = reflect(-L, N)      , 高光看 R·V
 *   Blinn-Phong : H = normalize(L + V)    , 高光看 N·H
 *   左右两个球体的几何、固有色、光源、shininess 完全相同, 只有高光模型不同:
 *   左边 Phong（高光斑小、边缘干净）, 右边 Blinn-Phong（高光斑大、过渡柔和）。
 *   同 shininess 下 Blinn 的高光面积更大, 想看起来接近一般要取 Phong 的 2~4 倍。
 *
 * 场景布置: 四盏点光源成对镜像、各自绕中心公转, 场景关于 x = 0 平面对称 ——
 * 两个球接到的光一模一样, 画面上唯一的差别只能来自高光模型。
 * 关灯的做法是把颜色传黑, 而不是加 if 或传光源数量: 循环次数永远是常量 4,
 * 循环里没有一个按光源判断的分支, 也避开了 GLSL ES 1.00 对动态下标的限制。
 */

import { multiply, perspective, rotationX, rotationY, translation } from '../utils/mat4.js';
import { showError } from '../utils/page-status.js';

// ---------- 1. 获取canvas元素 - 浏览器环境三维渲染基于canvas标签实现 ----------
const canvas = document.querySelector('#scene');
const apiStat = document.querySelector('#stat-api');
const sizeStat = document.querySelector('#stat-size');
// 本页光源一直在动, 是持续渲染循环, FPS 读数有效
const fpsStat = document.querySelector('#stat-fps');

// 操作说明面板: 由脚本自己创建, 换成其它示例脚本时不会留下本页的按键说明
const helpPanel = createHelpPanel();

try {
  main();
} catch (error) {
  console.error(error);
  showError(error.message);
}

function main() {
  // ---------- 2. 创建 WebGL 上下文 ----------
  const gl = canvas.getContext('webgl2') || canvas.getContext('webgl');
  if (!gl) throw new Error('当前浏览器不支持 WebGL。');

  // ---------- 3. 着色器源码（GLSL ES 1.00，WebGL 1 / 2 通用） ----------
  const meshVertexSource = /* glsl */ `
    attribute vec3 aPosition;
    attribute vec3 aNormal;

    uniform mat4 uMvp;
    uniform mat4 uModel;        // 光照在世界空间算, 所以世界坐标必须传给片元
    uniform mat3 uNormalMatrix; // 法线矩阵: 模型左上角 3x3（纯旋转 + 等比缩放时够用）

    varying vec3 vWorldPosition;
    varying vec3 vNormal;

    void main() {
      vec4 worldPosition = uModel * vec4(aPosition, 1.0);
      vWorldPosition = worldPosition.xyz;
      vNormal = uNormalMatrix * aNormal;
      gl_Position = uMvp * vec4(aPosition, 1.0);
    }
  `;

  // 多光源着色器: 比 2_phonglight_webgl.js 的单光源版本只多了「数组 + 循环累加」
  const meshFragmentSource = /* glsl */ `
    precision mediump float;

    // 光源数量必须是常量: 数组长度与循环上界都要求「常量表达式」, 不能让 JS 传进来。
    // 这个 4 必须和 JS 里的 MAX_LIGHTS 一致 —— 着色器与 JS 互相读不到对方的值。
    const int MAX_LIGHTS = 4;

    // 光源 = 一组参数的集合。GLSL ES 1.00 支持 uniform 结构体数组,
    // 元素由驱动打包, 取位置时写 'uLights[0].position' 这类带下标的名字。
    struct Light {
      vec3 position; // 世界空间的光源位置（点光源）
      vec3 color;    // 颜色 × 强度; 传 vec3(0.0) 表示这盏灯关掉了
    };

    uniform Light uLights[MAX_LIGHTS];

    uniform vec3 uColor;             // 物体固有色
    uniform vec3 uAmbientColor;      // 环境光颜色
    uniform vec3 uCameraPosition;    // 相机位置（世界空间），算高光要用
    uniform float uShininess;        // 高光锐利度: 越大高光越小越亮
    uniform float uSpecularStrength; // 高光强度
    uniform float uUseBlinn;         // 1.0 = Blinn-Phong, 0.0 = Phong

    varying vec3 vWorldPosition;
    varying vec3 vNormal;

    void main() {
      vec3 N = normalize(vNormal);                          // 法线
      vec3 V = normalize(uCameraPosition - vWorldPosition); // 指向相机（视线）

      // ① 环境光: 与光源无关, 循环外算一次
      vec3 ambient = uAmbientColor * uColor;

      // ② ③ 四盏灯逐盏累加
      vec3 diffuseSum = vec3(0.0);
      vec3 specularSum = vec3(0.0);

      // 循环下标 i 属于「常量索引表达式」, 所以 uLights[i] 合法;
      // 若换成运行时传入的 int 去索引数组, WebGL1 会直接编译报错。
      for (int i = 0; i < MAX_LIGHTS; i++) {
        vec3 toLight = uLights[i].position - vWorldPosition;
        float dist = length(toLight);
        vec3 L = toLight / dist; // 指向光源（已归一化）

        // 点光源衰减: 越远越暗。没有它, 四盏灯叠加必然过曝成一片白
        float attenuation = 1.0 / (1.0 + 0.07 * dist * dist);
        vec3 litColor = uLights[i].color * attenuation;

        // 漫反射（Lambert）: 背面（点积为负）截断为 0
        float diffuseFactor = max(dot(N, L), 0.0);
        diffuseSum += uColor * litColor * diffuseFactor;

        // 镜面高光: 两种模型只差「拿什么方向去点积」
        float specularFactor;
        if (uUseBlinn > 0.5) {
          vec3 H = normalize(L + V);                       // Blinn-Phong: 半程向量
          specularFactor = pow(max(dot(N, H), 0.0), uShininess);
        } else {
          vec3 R = reflect(-L, N);                         // Phong: 反射向量
          specularFactor = pow(max(dot(R, V), 0.0), uShininess);
        }
        specularSum += litColor * uSpecularStrength * specularFactor;
      }

      gl_FragColor = vec4(ambient + diffuseSum + specularSum, 1.0);
    }
  `;

  // 光源标记着色器: 用 POINTS 把每盏灯画成一个小方点, 方便肉眼确认光从哪来
  const pointVertexSource = /* glsl */ `
    attribute vec3 aPosition;

    uniform mat4 uMvp;
    uniform float uPointSize; // gl_PointSize 的单位是「绘制缓冲区的像素」
    uniform vec3 uColor;

    varying vec3 vColor;

    void main() {
      vColor = uColor;
      gl_PointSize = uPointSize;
      gl_Position = uMvp * vec4(aPosition, 1.0);
    }
  `;

  const pointFragmentSource = /* glsl */ `
    precision mediump float;

    varying vec3 vColor;

    void main() {
      gl_FragColor = vec4(vColor, 1.0);
    }
  `;

  // ---------- 4. 创建两个渲染程序 ----------
  const meshProgram = createProgram(gl, meshVertexSource, meshFragmentSource);
  const pointProgram = createProgram(gl, pointVertexSource, pointFragmentSource);

  // ---------- 5. 球体数据: 左右两个球共用一份 ----------
  // 几何 / 固有色 / 光源 / shininess 全部相同, 唯一变量是高光模型 → 对比才公平
  // 选球体不选立方体: 曲面法线连续, 高光斑一定落在看得见的地方, 大小与柔和的差别一眼可辨;
  // 立方体是平面, 点光源的高光常常只擦过棱边, 对比几乎看不出来。
  const SPHERE_RADIUS = 0.72;
  const sphere = buildSphere(SPHERE_RADIUS);

  gl.useProgram(meshProgram);
  const positionAttr = uploadAttribute(gl, meshProgram, 'aPosition', sphere.positions, 3);
  const normalAttr = uploadAttribute(gl, meshProgram, 'aNormal', sphere.normals, 3);
  const sphereIndexBuffer = uploadIndices(gl, sphere.indices);

  gl.useProgram(pointProgram);
  const markerAttr = uploadAttribute(gl, pointProgram, 'aPosition', [], 3);

  // ---------- 6. 四盏点光源（数组） ----------
  // 每盏灯的参数: 公转半径 / 高度 / 角速度 / 初相位 / 颜色（颜色里已经含强度）
  const MAX_LIGHTS = 4; // 必须与着色器里的 const int MAX_LIGHTS = 4 一致
  // 四盏灯成对镜像布置: 1/2 是一对暖白, 3/4 是一对冷蓝, 每对的 mirror 互为 ±1。
  // 镜像布置让整个场景关于 x = 0 平面对称 —— 左右两个球体接到的光完全对称,
  // 于是画面上唯一的差别只可能来自高光模型, 对比才有说服力。
  // 半径都大于「球体离场景中心的最远距离(约 2.2)」, 否则光源会钻进球体里。
  const LIGHTS = [
    { name: '暖黄·右', color: [1.25, 0.95, 0.58], radius: 3.6, height: 0.9, speed: 0.45, phase: 0.0, mirror: 1, enabled: true },
    { name: '暖黄·左', color: [1.25, 0.95, 0.58], radius: 3.6, height: 0.9, speed: 0.45, phase: 0.0, mirror: -1, enabled: true },
    { name: '冷蓝·右', color: [0.22, 0.50, 1.00], radius: 3.6, height: -0.3, speed: -0.65, phase: 1.9, mirror: 1, enabled: true },
    { name: '冷蓝·左', color: [0.22, 0.50, 1.00], radius: 3.6, height: -0.3, speed: -0.65, phase: 1.9, mirror: -1, enabled: true },
  ];

  const LIGHT_ORBIT_CENTER = [0, 1.1, 0]; // 四盏灯绕这个点公转
  const BLACK = [0, 0, 0];                // 「关灯」= 颜色传黑, 循环照跑, 只是不贡献亮度

  // 每盏灯当前的世界坐标, 每帧由 updateLightPositions() 重算
  LIGHTS.forEach((light) => {
    light.position = LIGHT_ORBIT_CENTER.slice();
  });

  // ---------- 7. 物体着色器的 uniform 位置 ----------
  const mvpLocation = gl.getUniformLocation(meshProgram, 'uMvp');
  const modelLocation = gl.getUniformLocation(meshProgram, 'uModel');
  const normalMatrixLocation = gl.getUniformLocation(meshProgram, 'uNormalMatrix');
  const colorLocation = gl.getUniformLocation(meshProgram, 'uColor');
  const ambientColorLocation = gl.getUniformLocation(meshProgram, 'uAmbientColor');
  const cameraPositionLocation = gl.getUniformLocation(meshProgram, 'uCameraPosition');
  const shininessLocation = gl.getUniformLocation(meshProgram, 'uShininess');
  const specularStrengthLocation = gl.getUniformLocation(meshProgram, 'uSpecularStrength');
  const useBlinnLocation = gl.getUniformLocation(meshProgram, 'uUseBlinn');

  // 数组 uniform 的位置按「名字里的下标」逐个查: 这就是 WebGL 版的偏移表 ——
  // 下标 → location 的映射由驱动维护。WebGPU 没有 getUniformLocation,
  // 同一份映射必须自己用字节偏移重算（见文件顶部注释）, 这是本功能在新 API 上的主要难点。
  const lightPositionLocations = LIGHTS.map((_, index) =>
    gl.getUniformLocation(meshProgram, `uLights[${index}].position`)
  );
  const lightColorLocations = LIGHTS.map((_, index) =>
    gl.getUniformLocation(meshProgram, `uLights[${index}].color`)
  );

  // 光源标记的 uniform
  const pointMvpLocation = gl.getUniformLocation(pointProgram, 'uMvp');
  const pointSizeLocation = gl.getUniformLocation(pointProgram, 'uPointSize');
  const pointColorLocation = gl.getUniformLocation(pointProgram, 'uColor');

  // ---------- 8. 光照与材质参数（不随重绘变化的部分） ----------
  // 深一点的固有色: 高光才跳得出来, 否则亮色物体把高光「吃掉」, Phong 与 Blinn 看不出区别
  const SPHERE_COLOR = [0.55, 0.56, 0.62];  // 两个球体的固有色完全一样
  const AMBIENT_COLOR = [0.16, 0.17, 0.20]; // 环境光偏冷: 抬亮背光面, 又不会吃掉多光源的对比
  const SHININESS = 18.0;                   // 两边同值: Blinn 的高光天生更宽, 差异才看得出来
  const SPECULAR_STRENGTH = 1.0;            // 高光强度

  // ---------- 9. 相机与投影 ----------
  // 轨道相机: yaw/pitch/distance/target 四个量就能重建任意视角（与 7_cullFace_webgl.js 相同）
  const FOV = (45 * Math.PI) / 180;
  const NEAR = 0.1;
  const FAR = 100;
  const DEFAULT_CAMERA = { yaw: 0, pitch: 0.28, distance: 7.2, target: [0, 0.75, 0] };
  const camera = { ...DEFAULT_CAMERA, target: DEFAULT_CAMERA.target.slice() };

  const PITCH_LIMIT = Math.PI / 2 - 0.02;
  const MIN_DISTANCE = 2.5;
  const MAX_DISTANCE = 20;
  const ROTATE_SPEED = 0.006;
  const ZOOM_SPEED = 0.0015;

  let projection;    // 只在 resize() 里按当前画布宽高比生成
  let pointSize = 10; // 光源标记的像素大小, 跟着 dpr 走

  function clamp(value, min, max) {
    return Math.min(Math.max(value, min), max);
  }

  // V = T(0,0,-d) · Rx(pitch) · Ry(-yaw) · T(-target)
  function buildView() {
    return multiply(
      translation(0, 0, -camera.distance),
      multiply(
        rotationX(camera.pitch),
        multiply(
          rotationY(-camera.yaw),
          translation(-camera.target[0], -camera.target[1], -camera.target[2])
        )
      )
    );
  }

  // 相机世界坐标: 视图矩阵把世界搬进相机空间, 反解回来就是
  //   cam = target + Ry(yaw) · Rx(-pitch) · (0, 0, distance)
  // 高光依赖视线方向, 相机一动这个值就必须重写, 不能像固定视角那样只传一次。
  function getCameraPosition() {
    const cosPitch = Math.cos(camera.pitch);
    return [
      camera.target[0] + camera.distance * cosPitch * Math.sin(camera.yaw),
      camera.target[1] + camera.distance * Math.sin(camera.pitch),
      camera.target[2] + camera.distance * cosPitch * Math.cos(camera.yaw),
    ];
  }

  function resetCamera() {
    camera.yaw = DEFAULT_CAMERA.yaw;
    camera.pitch = DEFAULT_CAMERA.pitch;
    camera.distance = DEFAULT_CAMERA.distance;
    camera.target = DEFAULT_CAMERA.target.slice();
  }

  function resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const width = Math.max(1, Math.round(canvas.clientWidth * dpr));
    const height = Math.max(1, Math.round(canvas.clientHeight * dpr));

    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }

    gl.viewport(0, 0, width, height);
    projection = perspective(FOV, width / height, NEAR, FAR);
    pointSize = 10 * dpr; // 标记点也要跟着 dpr 放大, 否则高 DPI 屏上细得像灰尘
    if (sizeStat) sizeStat.textContent = `${width} × ${height}`;
    // 渲染循环每帧都会重画, 这里不必手动 render()
  }

  // ---------- 10. 光源状态: 开关 + 公转 ----------
  let lightTime = 0; // 公转累计时间（暂停时不累加）
  let lightPaused = false;

  // 四盏灯各自公转: 同一个公式 + 各自的半径/高度/角速度/初相位 → 互不同步
  function updateLightPositions() {
    LIGHTS.forEach((light) => {
      const angle = light.phase + lightTime * light.speed;
      light.position = [
        LIGHT_ORBIT_CENTER[0] + light.mirror * Math.cos(angle) * light.radius,
        LIGHT_ORBIT_CENTER[1] + light.height,
        LIGHT_ORBIT_CENTER[2] + Math.sin(angle) * light.radius,
      ];
    });
  }

  function enabledLightCount() {
    return LIGHTS.filter((light) => light.enabled).length;
  }

  // 与 7_cullFace_webgl.js 的 applyCullState 同一个角色: 改状态 → 刷新界面读数
  function applyLightState() {
    if (apiStat) {
      apiStat.textContent = `WebGL · ${enabledLightCount()}/${MAX_LIGHTS}灯 · Phong | Blinn`;
    }
    helpPanel.lightKeys.forEach((key, index) => {
      if (key) key.classList.toggle('is-active', LIGHTS[index].enabled);
    });
    if (helpPanel.pauseKey) helpPanel.pauseKey.classList.toggle('is-active', lightPaused);
  }

  // ---------- 11. 每帧绘制 ----------
  const LEFT_SPHERE_MODEL = translation(-1.45, 0.72, 0); // 左: Phong
  const RIGHT_SPHERE_MODEL = translation(1.45, 0.72, 0); // 右: Blinn-Phong
  let viewProjection;

  function render() {
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.enable(gl.DEPTH_TEST);

    viewProjection = multiply(projection, buildView());
    updateLightPositions(); // 光源在动, 每帧重算位置

    gl.useProgram(meshProgram);

    // 传 - 光照数组: 四盏灯一次写完（关掉的传黑色, 循环照跑, 只是不贡献亮度）
    for (let i = 0; i < MAX_LIGHTS; i++) {
      gl.uniform3fv(lightPositionLocations[i], LIGHTS[i].position);
      gl.uniform3fv(lightColorLocations[i], LIGHTS[i].enabled ? LIGHTS[i].color : BLACK);
    }

    // 传 - 每帧都会变、或按绘制切换的量
    gl.uniform3fv(cameraPositionLocation, getCameraPosition()); // 轨道相机一动就要重写
    gl.uniform3fv(ambientColorLocation, AMBIENT_COLOR);
    gl.uniform1f(shininessLocation, SHININESS);
    gl.uniform1f(specularStrengthLocation, SPECULAR_STRENGTH);

    // 画 - 同一条程序、同一份顶点数据, 只切 uUseBlinn: 左 Phong, 右 Blinn-Phong
    drawMesh(LEFT_SPHERE_MODEL, SPHERE_COLOR, 0.0);
    drawMesh(RIGHT_SPHERE_MODEL, SPHERE_COLOR, 1.0);

    // 画 - 光源标记
    drawLightMarkers();
  }

  function drawMesh(model, color, useBlinn) {
    bindAttribute(gl, positionAttr);
    bindAttribute(gl, normalAttr);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, sphereIndexBuffer);

    gl.uniformMatrix4fv(mvpLocation, false, multiply(viewProjection, model));
    gl.uniformMatrix4fv(modelLocation, false, model); // 世界坐标要在片元里算光照
    gl.uniformMatrix3fv(normalMatrixLocation, false, extractNormalMatrix(model));
    gl.uniform3fv(colorLocation, color);
    gl.uniform1f(useBlinnLocation, useBlinn);

    gl.drawElements(gl.TRIANGLES, sphere.indices.length, gl.UNSIGNED_SHORT, 0);
  }

  function drawLightMarkers() {
    // 只标记还亮着的灯: 关掉的灯位置仍在数组里, 但画个黑点没有意义
    const active = LIGHTS.filter((light) => light.enabled);
    if (active.length === 0) return;

    gl.useProgram(pointProgram);
    gl.uniformMatrix4fv(pointMvpLocation, false, viewProjection);
    gl.uniform1f(pointSizeLocation, pointSize);

    // 点的位置每帧都在变, 每次重新上传（数据量只有 3~12 个 float, 随便传）
    bindAttribute(gl, markerAttr);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(active.flatMap((light) => light.position)), gl.DYNAMIC_DRAW);

    // 每盏灯颜色不同 → 逐点绘制, 一个 draw 只写一种颜色
    active.forEach((light, index) => {
      gl.uniform3fv(pointColorLocation, light.color);
      gl.drawArrays(gl.POINTS, index, 1);
    });
  }

  // ---------- 12. 渲染循环 ----------
  const LIGHT_SPEED_SCALE = 0.35; // 公转整体快慢, 单独抽出来方便调
  let lastTime = 0;
  let frameCount = 0; // FPS 统计: 每 0.5 秒结算一次
  let elapsed = 0;

  function frame(now) {
    if (lastTime === 0) lastTime = now;
    const delta = Math.min((now - lastTime) / 1000, 0.1); // 切后台再回来时截断, 避免「瞬移」
    lastTime = now;

    if (!lightPaused) lightTime += delta * LIGHT_SPEED_SCALE;
    render();

    frameCount++;
    elapsed += delta;
    if (elapsed >= 0.5) {
      if (fpsStat) fpsStat.textContent = String(Math.round(frameCount / elapsed));
      frameCount = 0;
      elapsed = 0;
    }

    requestAnimationFrame(frame);
  }

  // ---------- 13. 鼠标控制相机（与 4_camera_control_webgl.js 相同的轨道相机） ----------
  const ROTATE_BUTTON = 0;
  const PAN_BUTTON = 2;

  let activePointerId = null;
  let dragMode = null; // 'orbit' | 'pan'
  let lastX = 0;
  let lastY = 0;

  canvas.style.cursor = 'grab';

  function handlePointerDown(event) {
    if (activePointerId !== null) return;
    if (event.button === ROTATE_BUTTON) dragMode = 'orbit';
    else if (event.button === PAN_BUTTON) dragMode = 'pan';
    else return;

    activePointerId = event.pointerId;
    lastX = event.clientX;
    lastY = event.clientY;
    canvas.setPointerCapture(event.pointerId);
    canvas.style.cursor = 'grabbing';
  }

  function handlePointerMove(event) {
    if (event.pointerId !== activePointerId) return;

    const dx = event.clientX - lastX;
    const dy = event.clientY - lastY;
    lastX = event.clientX;
    lastY = event.clientY;

    if (dragMode === 'orbit') {
      camera.yaw -= dx * ROTATE_SPEED;
      camera.pitch = clamp(camera.pitch + dy * ROTATE_SPEED, -PITCH_LIMIT, PITCH_LIMIT);
    } else if (dragMode === 'pan') {
      // 观察点沿相机的右/上方向移动, 拖动方向和画面永远对得上
      const worldPerPixel = (2 * camera.distance * Math.tan(FOV / 2)) / Math.max(1, canvas.clientHeight);
      const cosYaw = Math.cos(camera.yaw);
      const sinYaw = Math.sin(camera.yaw);
      const cosPitch = Math.cos(camera.pitch);
      const sinPitch = Math.sin(camera.pitch);
      const right = [cosYaw, 0, -sinYaw];
      const up = [-sinYaw * sinPitch, cosPitch, -cosYaw * sinPitch];

      for (let i = 0; i < 3; i++) {
        camera.target[i] += -right[i] * dx * worldPerPixel + up[i] * dy * worldPerPixel;
      }
    }
    // 有渲染循环, 不必在这里手动 render()
  }

  function handlePointerUp(event) {
    if (event.pointerId !== activePointerId) return;
    activePointerId = null;
    dragMode = null;
    canvas.style.cursor = 'grab';
  }

  function handleWheel(event) {
    event.preventDefault();
    const deltaY = event.deltaMode === 1 ? event.deltaY * 16 : event.deltaY;
    // 指数缩放: 远近处每格滚轮的手感一致
    camera.distance = clamp(camera.distance * Math.exp(deltaY * ZOOM_SPEED), MIN_DISTANCE, MAX_DISTANCE);
  }

  canvas.addEventListener('pointerdown', handlePointerDown);
  canvas.addEventListener('pointermove', handlePointerMove);
  canvas.addEventListener('pointerup', handlePointerUp);
  canvas.addEventListener('pointercancel', handlePointerUp);
  canvas.addEventListener('wheel', handleWheel, { passive: false });
  canvas.addEventListener('dblclick', resetCamera);
  canvas.addEventListener('contextmenu', (event) => event.preventDefault());

  // ---------- 14. 键盘控制光源 ----------
  window.addEventListener('keydown', (event) => {
    const key = event.key.toLowerCase();

    if (key >= '1' && key <= '4') {
      // 下标直接对应 uniform 数组里的 uLights[0..3], 按数字键就是改数组里的一项
      const index = Number(key) - 1;
      LIGHTS[index].enabled = !LIGHTS[index].enabled;
      applyLightState();
    } else if (key === 'p') {
      lightPaused = !lightPaused;
      applyLightState();
    } else if (key === 'r') {
      resetCamera();
    }
  });

  // ---------- 15. 启动 ----------
  applyLightState(); // 默认: 四盏灯全开 + 公转中, 上面板高亮同步
  resize();
  window.addEventListener('resize', resize);
  document.body.classList.add('is-ready');
  requestAnimationFrame(frame);
}

/* =============== 数据准备 =============== */

/**
 * 球体（带法线, 用索引绘制）
 * 经纬网格: rings 圈纬线 × segments 段经线, 球面上每点的法线就是它自己的单位方向
 * 关键约定: 三角形从球外面看过去逆时针 —— 与「法线朝外」一致, 关掉背面剔除也不会看出破面
 * @param {number} radius 半径
 * @param {number} segments 经线分段数（水平方向）
 * @param {number} rings 纬线分段数（垂直方向）
 */
function buildSphere(radius, segments = 48, rings = 32) {
  const positions = [];
  const normals = [];
  const indices = [];

  for (let ring = 0; ring <= rings; ring++) {
    const phi = (ring / rings) * Math.PI; // 0 在北极, π 在南极
    const sinPhi = Math.sin(phi);
    const cosPhi = Math.cos(phi);

    for (let segment = 0; segment <= segments; segment++) {
      const theta = (segment / segments) * Math.PI * 2;
      // 单位方向就是法线, 乘半径就是顶点
      const nx = sinPhi * Math.cos(theta);
      const ny = cosPhi;
      const nz = sinPhi * Math.sin(theta);

      positions.push(nx * radius, ny * radius, nz * radius);
      normals.push(nx, ny, nz);
    }
  }

  for (let ring = 0; ring < rings; ring++) {
    for (let segment = 0; segment < segments; segment++) {
      const current = ring * (segments + 1) + segment;
      const below = current + segments + 1;

      // 一个四边形格子拆成两个三角形, 绕序统一为逆时针（从外部看）
      indices.push(current, current + 1, below, current + 1, below + 1, below);
    }
  }

  return { positions, normals, indices };
}

/**
 * 法线矩阵: 模型矩阵只有旋转和平移（没有缩放）, 左上角 3x3 就是法线矩阵
 * 若含非等比缩放, 必须用左上角 3x3 的逆转置, 否则法线会被拉歪
 * 注意 gl.uniformMatrix3fv 要 9 个 float, 与 WebGPU 里 mat3x3 每列补到 16 字节完全不同
 */
function extractNormalMatrix(model) {
  return new Float32Array([
    model[0], model[1], model[2],
    model[4], model[5], model[6],
    model[8], model[9], model[10],
  ]);
}

/* =============== 缓冲区与属性 =============== */

/**
 * 上传一个顶点属性（位置 / 法线都走这条路径）
 * 返回的不只是缓冲区, 还带上它属于哪个程序、哪个 location、每个顶点几个分量,
 * 之后每次绘制前用 bindAttribute 重新绑定 —— 多个程序共用全局属性状态时必须重绑
 */
function uploadAttribute(gl, program, name, data, components) {
  const location = gl.getAttribLocation(program, name);
  const buffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(data), gl.STATIC_DRAW);
  return { location, buffer, components };
}

function bindAttribute(gl, attribute) {
  gl.bindBuffer(gl.ARRAY_BUFFER, attribute.buffer);
  gl.vertexAttribPointer(attribute.location, attribute.components, gl.FLOAT, false, 0, 0);
  gl.enableVertexAttribArray(attribute.location);
}

function uploadIndices(gl, indices) {
  const buffer = gl.createBuffer();
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, buffer);
  gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint16Array(indices), gl.STATIC_DRAW);
  return buffer;
}

/* =============== 着色器与程序 =============== */

function createShader(gl, type, source) {
  // 1. 创建着色器
  const shader = gl.createShader(type);
  // 2. 将着色器代码绑定到着色器对象
  gl.shaderSource(shader, source);
  // 3. 编译着色器代码
  gl.compileShader(shader);
  // 4. 检查着色器代码是否报错
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader);
    gl.deleteShader(shader);
    throw new Error(`着色器编译失败：\n${log}`);
  }
  return shader;
}

function createProgram(gl, vertexSource, fragmentSource) {
  const vertexShader = createShader(gl, gl.VERTEX_SHADER, vertexSource);
  const fragmentShader = createShader(gl, gl.FRAGMENT_SHADER, fragmentSource);

  // 1. 创建渲染对象, 一个渲染对象表示一个完整的渲染流程
  const program = gl.createProgram();
  // 2. 将上面创建好的着色器放入渲染对象中
  gl.attachShader(program, vertexShader);
  gl.attachShader(program, fragmentShader);
  // 3. 链接渲染程序, 检查顶点着色器与片元着色器之间的传值是否报错
  gl.linkProgram(program);
  // 4. 检查渲染对象链接是否成功
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(program);
    gl.deleteProgram(program);
    throw new Error(`程序链接失败：\n${log}`);
  }
  return program;
}

/* =============== 操作说明面板 =============== */

/**
 * 在页面右上角生成操作说明面板（样式见 ui/style.css 的 .hud--help）
 * 返回需要随状态高亮的按键元素: lightKeys 按 1~4 对应四盏光源, pauseKey 对应光源旋转开关
 */
function createHelpPanel() {
  // 面板内容就是本文件顶部注释里的那份操作表, 改按键时两处一起改
  const sections = [
    {
      title: '鼠标',
      items: [
        { keys: ['左键拖动'], desc: '旋转观察' },
        { keys: ['右键拖动'], desc: '平移' },
        { keys: ['滚轮'], desc: '缩放' },
        { keys: ['双击'], desc: '复位视角' },
      ],
    },
    {
      title: '键盘',
      items: [
        { keys: ['1'], desc: '开关 暖黄·右', light: 0 },
        { keys: ['2'], desc: '开关 暖黄·左', light: 1 },
        { keys: ['3'], desc: '开关 冷蓝·右', light: 2 },
        { keys: ['4'], desc: '开关 冷蓝·左', light: 3 },
        { keys: ['P'], desc: '暂停/继续光源旋转', pause: true },
        { keys: ['R'], desc: '复位视角' },
      ],
    },
  ];

  const panel = document.createElement('aside');
  panel.className = 'hud hud--help';
  panel.setAttribute('aria-label', '操作说明');

  const card = document.createElement('div');
  card.className = 'help';

  const title = document.createElement('h2');
  title.className = 'help__title';
  title.textContent = '操作说明';
  card.appendChild(title);

  const lightKeys = [];
  let pauseKey = null;

  sections.forEach((section) => {
    const group = document.createElement('section');
    group.className = 'help__group';

    const groupTitle = document.createElement('h3');
    groupTitle.className = 'help__group-title';
    groupTitle.textContent = section.title;
    group.appendChild(groupTitle);

    // dt 放按键, dd 放说明 —— 两列由 CSS 网格对齐, 所以不额外包行元素
    const list = document.createElement('dl');
    list.className = 'help__list';

    section.items.forEach((item) => {
      const term = document.createElement('dt');
      item.keys.forEach((key) => {
        const kbd = document.createElement('kbd');
        kbd.textContent = key;
        term.appendChild(kbd);
      });

      const desc = document.createElement('dd');
      desc.textContent = item.desc;

      if (item.light !== undefined) lightKeys[item.light] = term;
      if (item.pause) pauseKey = term;

      list.append(term, desc);
    });

    group.appendChild(list);
    card.appendChild(group);
  });

  panel.appendChild(card);
  document.body.appendChild(panel);

  return { lightKeys, pauseKey };
}

