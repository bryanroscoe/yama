"""Add a `cuts` input (required) to a query embed graph: only those frame cuts go through the CNN, and the
output keeps all 17 rows (zeros for the others, which the search scores at minus their penalty). `cuts`
is a required input (onnxruntime-web won't take a feed for an initializer), so only a client that knows it
loads this graph; fed 0..16 it gives the whole graph's answer.
python <lab>/cascade.py IN.onnx OUT.onnx   (yama-art-20261118.onnx -> yama-art-20261118-cascade.onnx, byte for byte)"""
import sys
import numpy as np, onnx
from onnx import helper, numpy_helper, TensorProto

src, dst = sys.argv[1], sys.argv[2]
m = onnx.load(src)
g = m.graph
CROPS = "/Div_5_output_0"
consumers = [n for n in g.node if CROPS in n.input]
assert consumers, "no crops tensor"
nodes = list(g.node)
out_name = g.output[0].name  # embeddings
producer = next(n for n in nodes if out_name in n.output)
F = 17
# Rewire: the CNN reads Gather(crops, cuts); its result becomes `picked`; ScatterND fills 17 rows.
for n in consumers:
    n.input[:] = ["cascade_crops" if x == CROPS else x for x in n.input]
producer.output[:] = ["cascade_picked" if x == out_name else x for x in producer.output]
for n in nodes:
    if n is not producer and "cascade_picked" not in n.output:
        n.input[:] = ["cascade_picked" if x == out_name else x for x in n.input]
gather = helper.make_node("Gather", [CROPS, "cuts"], ["cascade_crops"], name="cascade/Gather", axis=0)
idx = helper.make_node("Unsqueeze", ["cuts", "cascade_axis"], ["cascade_idx"], name="cascade/Unsqueeze")
shape = helper.make_node("Shape", ["cascade_picked"], ["cascade_pshape"], name="cascade/Shape")
dim = helper.make_node("Slice", ["cascade_pshape", "cascade_one", "cascade_two"], ["cascade_dim"], name="cascade/Slice")
full = helper.make_node("Concat", ["cascade_f", "cascade_dim"], ["cascade_shape"], name="cascade/Concat", axis=0)
zeros = helper.make_node("ConstantOfShape", ["cascade_shape"], ["cascade_zeros"], name="cascade/Zeros", value=numpy_helper.from_array(np.zeros(1, np.float32)))
scatter = helper.make_node("ScatterND", ["cascade_zeros", "cascade_idx", "cascade_picked"], [out_name], name="cascade/ScatterND")
pos = nodes.index(consumers[0])
g.ClearField("node")
g.node.extend(nodes[:pos] + [gather] + nodes[pos:] + [idx, shape, dim, full, zeros, scatter])
g.initializer.extend([
    numpy_helper.from_array(np.array([1], np.int64), "cascade_axis"),
    numpy_helper.from_array(np.array([1], np.int64), "cascade_one"),
    numpy_helper.from_array(np.array([2], np.int64), "cascade_two"),
    numpy_helper.from_array(np.array([F], np.int64), "cascade_f"),
])
g.input.append(helper.make_tensor_value_info("cuts", TensorProto.INT64, ["k"]))
if m.ir_version < 4: m.ir_version = 4
onnx.checker.check_model(m)
onnx.save(m, dst)
print(dst)
