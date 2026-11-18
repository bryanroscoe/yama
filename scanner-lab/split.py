"""Cut the bundle's embed.onnx in two at its normalised crops (node /Div_5):
- models/front.onnx: (scene, quad) -> the 17 frame cuts, 128x128, ImageNet-normalised. gen.py makes
  training crops with it and export.py puts it back in front of the fine-tuned embedder unchanged.
- models/back.onnx: the crops -> embeddings (MobileNetV3-Small, folded BN, 576->128, L2 norm), with
  the batch made free ("N"). model.py loads its weights into PyTorch.
python <lab>/split.py
For the 6 Nov bundle this makes front.onnx sha256 fde76850... and back.onnx b7f9692f..., the files
yama-art-20261118 was trained and exported from."""
import hashlib, os
import onnx, onnx.utils
from paths import BUNDLE

CUT = "/Div_5_output_0"

if __name__ == "__main__":
    os.makedirs("models", exist_ok=True)
    src = os.path.join(BUNDLE, "embed.onnx")
    onnx.utils.extract_model(src, "models/front.onnx", ["scene", "quad"], [CUT])
    onnx.utils.extract_model(src, "models/back.onnx", [CUT], ["embeddings"])
    back = onnx.load("models/back.onnx")
    back.graph.input[0].type.tensor_type.shape.dim[0].dim_param = "N"
    back.graph.output[0].type.tensor_type.shape.dim[0].dim_param = "N"
    del back.graph.value_info[:]
    onnx.save(back, "models/back.onnx")
    for f in ("models/front.onnx", "models/back.onnx"):
        print(f, hashlib.sha256(open(f, "rb").read()).hexdigest())
