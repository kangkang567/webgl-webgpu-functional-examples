# Phong 光照算法总结

对应实现：`2_phonglight_webgl.js`（WebGL）、`2_phonglight_webgpu.js`（WebGPU）。
两者绘制同一内容、使用同一套光照公式，只有 API 层面的写法不同。

## 一、模型组成

Phong 光照模型把「一个像素最终的颜色」拆成三项相加：

\[
C = C_{ambient} + C_{diffuse} + C_{specular}
\]

| 项 | 中文名 | 作用 | 是否依赖法线 |
| --- | --- | --- | --- |
| 环境光 ambient | 环境光 | 模拟场景中四处反弹的间接光，保证背光面不是纯黑 | 否 |
| 漫反射 diffuse | 漫反射 | 粗糙表面的基础明暗，光线越正对表面越亮 | 是 |
| 镜面高光 specular | 镜面高光 | 光滑表面的反光亮点，体现材质光滑度 | 是 |

三项都是逐通道（RGB）计算的向量，最后相加并写入 `alpha = 1`。

## 二、每个像素需要的三个方向向量

光照计算全部在世界空间（world space）中进行，因此需要在片元里得到像素的世界坐标。

| 符号 | 名称 | 计算方式 |
| --- | --- | --- |
| \(N\) | 法线 | `normalize(uNormalMatrix * aNormal)`，由顶点着色器插值后归一化 |
| \(L\) | 指向光源 | `normalize(lightPosition - worldPosition)` |
| \(V\) | 指向相机（视线） | `normalize(cameraPosition - worldPosition)` |
| \(R\) | 反射向量 | `reflect(-L, N)`，即光线方向关于法线的镜像 |

要点：
- 光照在**片元着色器**里算，N/L/V 都是逐像素插值后再归一化 → 逐像素光照（Phong Shading），高光平滑细腻。
- 若把同样的公式写在顶点着色器里，就是逐顶点光照（Gouraud Shading），高光会在三角形上断裂。
- 一切参与点积的向量都必须先 `normalize`，否则亮度会随距离变化而失真。

## 三、三项的具体公式

### 1. 环境光

\[
C_{ambient} = C_{ambientColor} \times C_{object}
\]

没有方向、没有衰减，直接相乘。它只负责「抬亮阴影」，不产生任何立体感。

### 2. 漫反射（Lambert）

\[
C_{diffuse} = C_{object} \times C_{light} \times \max(N \cdot L,\ 0)
\]

- \(N \cdot L = \cos\theta\)，\(\theta\) 是法线与光线夹角：正对光源时为 1（最亮），90° 时为 0。
- `max(..., 0)` 把背面（点积为负）截断为 0，否则背光面会出现反向亮斑。
- 漫反射只和物体固有色、光源颜色有关，与相机位置无关。

### 3. 镜面高光（Phong 版）

\[
C_{specular} = C_{light} \times k_s \times \max(R \cdot V,\ 0)^{shininess}
\]

计算思路：先求出光线在表面上的反射方向 \(R\)，再看 \(R\) 与视线 \(V\) 是否重合。

- \(R \cdot V\) 越接近 1，说明反射光正好射入眼睛，高光越亮。
- `pow(..., shininess)` 把「接近 1」的区域压得更窄：`shininess` 越大，高光越**小且集中**（表面越光滑）。
- \(k_s\)（`specularStrength`）控制高光整体强度，通常 0.5 ~ 1.0。
- 高光颜色取光源颜色（金属材质才会让高光染上固有色）。

## 四、参数与代码对应

| 参数 | 代码变量 | 示例值 | 说明 |
| --- | --- | --- | --- |
| 物体固有色 | `CUBE_COLOR` / `uColor` | `[0.36, 0.55, 1.0]` | 蓝色立方体 |
| 光源颜色 | `LIGHT_COLOR` / `uLightColor` | `[1.0, 1.0, 1.0]` | 白色光 |
| 光源位置 | `LIGHT_POSITION` / `uLightPosition` | `[4.0, 6.0, 7.0]` | 世界空间，物体右上前方（点光源） |
| 相机位置 | `CAMERA_POSITION` / `uCameraPosition` | 由 view 矩阵反解 | 算高光必须知道眼睛在哪 |
| 环境光颜色 | `AMBIENT_COLOR` / `uAmbientColor` | `[0.16, 0.18, 0.22]` | 偏冷，让背光面有层次 |
| 高光锐利度 | `SHININESS` / `uShininess` | `48.0` | 越大高光越小越亮 |
| 高光强度 | `SPECULAR_STRENGTH` / `uSpecularStrength` | `0.9` | 高光整体倍率 |

相机位置由视图矩阵反解得到：视图矩阵 \(V_{view} = T(0,0,-6.5) \cdot R_x(0.25)\)，等价于相机在世界空间中绕原点旋转，因此

```js
const CAMERA_POSITION = [0, 6.5 * Math.sin(0.25), 6.5 * Math.cos(0.25)];
```

## 五、除光照公式之外的两个关键点

### 1. 必须提供法线数据

与第 1 步的基础渲染相比，Phong 光照唯一新增的顶点属性是 `aNormal`：

- 立方体是硬边，同一个面的 6 个顶点共用同一个法线，因此每个面呈现一个亮度。
- 若要让曲面平滑，需要让相邻面共享顶点、法线取平均（球、圆柱等模型天然如此）。

### 2. 法线矩阵

法线不能直接用模型矩阵变换，正确做法是使用模型矩阵左上角 3×3 的**逆转置**：

- 代码中模型矩阵只有旋转，旋转的逆转置等于自身，所以直接取左上角 3×3。
- 一旦含**非等比缩放**，必须改用逆转置，否则法线被拉歪，光照方向全错。

```js
// WebGL: mat3 只存 9 个 float
const normalMatrix = new Float32Array([
  model[0], model[1], model[2],
  model[4], model[5], model[6],
  model[8], model[9], model[10],
]);
```

WebGPU 的 WGSL 中 `mat3x3<f32>` 每列补齐到 16 字节，所以上传时要拼成 12 个 float、每列末尾留 1 个填充：

```js
const normalMatrix = new Float32Array(12);
normalMatrix.set([model[0], model[1], model[2]], 0);
normalMatrix.set([model[4], model[5], model[6]], 4);
normalMatrix.set([model[8], model[9], model[10]], 8);
```

## 六、两个平台的差异（与光照相关的部分）

| 环节 | WebGL | WebGPU |
| --- | --- | --- |
| 光照参数传递 | 每个 uniform 一个 `gl.uniformXxx` | 合并为一个 `struct` + 一块 uniform 缓冲区，按偏移写 `Float32Array` |
| 结构体总大小 | 无需关心 | 需手动对齐：`vec3` 按 16 字节对齐，整体补到 16 的倍数（本例 272 字节） |
| 传递世界坐标/法线 | `varying vec3` | 顶点着色器返回结构体 + `@location(n)` |
| 深度测试 | `gl.enable(gl.DEPTH_TEST)` | 管线 `depthStencil` 中声明 |

## 七、常见坑

1. **WGSL 的 `pow` 在底数为 0 时返回 NaN**。WGSL 的 `pow(x, y)` 等价于 `exp2(y * log2(x))`，`x = 0` 时对数无定义，NaN 会污染整个颜色（表现为模型全黑）。必须用 `select` 单独处理：

   ```wgsl
   let rv = max(dot(R, V), 0.0);
   let specularFactor = select(0.0, pow(rv, uniforms.shininess), rv > 0.0);
   ```

   GLSL 的 `pow(0.0, n)` 定义为 0，所以 WebGL 版不需要这层保护。

2. **忘记归一化**。L、V、N 任一未归一化，点积结果就不再是余弦值，亮度会随光源/相机距离变化。

3. **在模型空间算法线光照**。若法线用模型矩阵的左上角 3×3 变换后直接与光源方向点积，模型一旋转光照就跟着转，看起来像「光贴在物体上走」。

4. **只翻转法线却忘了背面截断**。`max(N·L, 0)` 是必须的，否则背面拿到负值会产生反向亮斑。

5. **高光没有随相机变化**。Phong 高光依赖视线 \(V\)，相机位置必须传进着色器；只传 MVP 矩阵是不够的。

## 八、参数调节的直观效果

| 调什么 | 效果 |
| --- | --- |
| 提高 `shininess`（如 48 → 256） | 高光斑变小、变锐利，像抛光金属/塑料 |
| 降低 `shininess`（如 48 → 8） | 高光铺开成一大片，像磨砂或橡胶 |
| 调高 `ambientColor` | 背光面变亮、对比度下降，画面发灰 |
| 调高 `lightPosition.y` | 顶面变亮、侧面变暗，形体更「从上打光」 |
| 光源移到相机方向附近 | 高光出现在正视面上，最明显 |

## 九、与 Blinn-Phong 的关系

Phong 用反射向量 \(R\) 与视线 \(V\) 比较，Blinn-Phong 改用**半程向量** \(H = \dfrac{L + V}{\|L + V\|}\)：

\[
C_{specular}^{Blinn} = C_{light} \times k_s \times \max(N \cdot H,\ 0)^{shininess}
\]

- 少算一次 `reflect`，更快；高光形状在大角度下也更接近真实观测。
- 代价是 `shininess` 的物理含义改变，两者数值不能直接照搬（Blinn 一般取 Phong 的 2~4 倍）。
- 两者都是经验模型，没有能量守恒，也不处理菲涅尔效应；真实感渲染需继续引入 PBR。
