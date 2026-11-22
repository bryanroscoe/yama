"""Extract the one-crop art network from the released Yama query graph."""

import argparse
from pathlib import Path

import numpy as np
import onnx
import onnxruntime as ort


CROP_TENSOR = "/Div_5_output_0"


def single_crop_model(source):
    model = onnx.utils.Extractor(source).extract_model([CROP_TENSOR], ["embeddings"])
    crop = onnx.helper.make_tensor_value_info("crops", onnx.TensorProto.FLOAT, [1, 3, 128, 128])
    embeddings = onnx.helper.make_tensor_value_info("embeddings", onnx.TensorProto.FLOAT, [1, 128])
    model.graph.input[0].CopyFrom(crop)
    model.graph.output[0].CopyFrom(embeddings)
    for node in model.graph.node:
        for index, name in enumerate(node.input):
            if name == CROP_TENSOR:
                node.input[index] = crop.name
    onnx.checker.check_model(model, full_check=True)
    return model


def verify(source, model):
    front = onnx.utils.Extractor(source).extract_model(["scene", "quad"], [CROP_TENSOR])
    options = ort.SessionOptions()
    options.intra_op_num_threads = 1
    options.inter_op_num_threads = 1

    def session(graph):
        return ort.InferenceSession(graph.SerializeToString(), options, providers=["CPUExecutionProvider"])

    preprocessing = session(front)
    combined = session(source)
    embed = session(model)
    rng = np.random.default_rng(20261121)
    max_delta = 0.0
    for height, width, corners in (
        (640, 480, [[60, 40], [420, 50], [430, 600], [50, 590]]),
        (480, 640, [[519, 75], [495, 394], [95, 370], [69, 80]]),
    ):
        scene = rng.integers(0, 256, (height, width, 4), dtype=np.uint8)
        scene[..., 3] = 255
        inputs = {"scene": scene, "quad": np.asarray(corners, dtype=np.float32)}
        crops, = preprocessing.run(None, inputs)
        expected, = combined.run(None, inputs)
        actual = np.concatenate([embed.run(None, {"crops": crop[None]})[0] for crop in crops])
        np.testing.assert_array_equal(actual.shape, (17, 128))
        np.testing.assert_array_equal(expected.shape, (17, 128))
        if not np.isfinite(expected).all() or not np.isfinite(actual).all():
            raise ValueError("non-finite embedding in the parity check")
        np.testing.assert_allclose(actual, expected, rtol=1e-5, atol=1e-6)
        max_delta = max(max_delta, float(np.max(np.abs(actual - expected))))
    return max_delta


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path, help="released yama-art-20261118.onnx (full graph)")
    parser.add_argument("output", type=Path, help="destination for the fixed one-crop ONNX")
    args = parser.parse_args()
    if args.source.resolve() == args.output.resolve():
        parser.error("output must be a different file from source")

    source = onnx.load(args.source)
    model = single_crop_model(source)
    max_delta = verify(source, model)
    onnx.save(model, args.output)
    print(f"{args.output}: 34 crops agreed with the full graph (max absolute error {max_delta:.3g})")


if __name__ == "__main__":
    main()
