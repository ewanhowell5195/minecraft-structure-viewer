// Extracts the game's hardcoded (code-built) structures into standard
// structure .nbt files by running the real piece/feature code against a
// capturing WorldGenLevel. Compiled with javac against the unobfuscated
// server jar and run by extract.js.
//
// Pieces are instantiated with orientation NORTH: coords map to
// world = (minX + x, minY + y, maxZ - z) with NO state mirror/rotation,
// so un-flipping z at write time recovers the exact authored local blocks.
// The viewer's layout generators re-apply the game's orientation transform.
import java.lang.reflect.InvocationHandler;
import java.lang.reflect.Method;
import java.lang.reflect.Proxy;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.*;
import net.minecraft.SharedConstants;
import net.minecraft.core.BlockPos;
import net.minecraft.core.Direction;
import net.minecraft.core.HolderLookup;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.data.registries.VanillaRegistries;
import net.minecraft.nbt.CompoundTag;
import net.minecraft.nbt.DoubleTag;
import net.minecraft.nbt.IntTag;
import net.minecraft.nbt.ListTag;
import net.minecraft.nbt.NbtIo;
import net.minecraft.server.Bootstrap;
import net.minecraft.util.RandomSource;
import net.minecraft.world.level.ChunkPos;
import net.minecraft.world.level.LevelHeightAccessor;
import net.minecraft.world.level.WorldGenLevel;
import net.minecraft.world.level.block.Blocks;
import net.minecraft.world.level.block.EntityBlock;
import net.minecraft.world.level.block.entity.BlockEntity;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.level.block.state.properties.Property;
import net.minecraft.world.level.chunk.ChunkAccess;
import net.minecraft.world.level.chunk.status.ChunkStatus;
import net.minecraft.world.level.chunk.PalettedContainerFactory;
import net.minecraft.world.level.chunk.UpgradeData;
import net.minecraft.world.level.levelgen.feature.EndGatewayFeature;
import net.minecraft.world.level.levelgen.feature.EndPlatformFeature;
import net.minecraft.world.level.levelgen.feature.EndPodiumFeature;
import net.minecraft.world.level.levelgen.structure.BoundingBox;
import net.minecraft.world.entity.Entity;
import net.minecraft.world.level.material.Fluid;
import net.minecraft.world.level.block.Block;
import net.minecraft.world.ticks.TickContainerAccess;

public class BuiltinExtract {
  static HolderLookup.Provider REGS;
  static Path OUT;

  // ---------------------------------------------------------------- random

  // A random that returns fixed values, so extraction is canonical and
  // repeatable. floatVal is tunable per run: diffing two runs with different
  // floatVal exposes exactly the cells a BlockSelector randomises.
  static class CannedRandom implements RandomSource {
    float floatVal;
    CannedRandom(float f) { floatVal = f; }
    public RandomSource fork() { return new CannedRandom(floatVal); }
    public net.minecraft.world.level.levelgen.PositionalRandomFactory forkPositional() { throw new UnsupportedOperationException("forkPositional"); }
    public void setSeed(long seed) {}
    public int nextInt() { return 0; }
    public int nextInt(int bound) { return 0; }
    public long nextLong() { return 0; }
    public boolean nextBoolean() { return false; }
    public float nextFloat() { return floatVal; }
    public double nextDouble() { return floatVal; }
    public double nextGaussian() { return 0; }
  }

  // ---------------------------------------------------------------- capture

  static class DummyChunk extends ChunkAccess {
    DummyChunk() {
      super(new ChunkPos(0, 0), UpgradeData.EMPTY, LevelHeightAccessor.create(0, 0),
        new PalettedContainerFactory(null, null, null, null, null, null), 0L, null, null);
    }
    @Override public void markPosForPostProcessing(BlockPos pos) {}
    public BlockState setBlockState(BlockPos pos, BlockState state, int flags) { return null; }
    public void setBlockEntity(BlockEntity blockEntity) {}
    public void addEntity(Entity entity) {}
    public ChunkStatus getPersistedStatus() { return ChunkStatus.EMPTY; }
    public void removeBlockEntity(BlockPos pos) {}
    public CompoundTag getBlockEntityNbtForSaving(BlockPos pos, HolderLookup.Provider regs) { return null; }
    public TickContainerAccess<Block> getBlockTicks() { return null; }
    public TickContainerAccess<Fluid> getFluidTicks() { return null; }
    public ChunkAccess.PackedTicks getTicksForSerialization(long tick) { return null; }
    public BlockState getBlockState(BlockPos pos) { return Blocks.AIR.defaultBlockState(); }
    public net.minecraft.world.level.material.FluidState getFluidState(BlockPos pos) { return Blocks.AIR.defaultBlockState().getFluidState(); }
    public BlockEntity getBlockEntity(BlockPos pos) { return null; }
  }

  static class Capture {
    final Map<BlockPos, BlockState> placed = new LinkedHashMap<>();
    final Map<BlockPos, BlockEntity> bes = new HashMap<>();
    final List<CompoundTag> entities = new ArrayList<>();
    final Map<BlockPos, BlockState> world = new HashMap<>(); // pre-existing terrain, not captured
    int groundY = Integer.MIN_VALUE;                          // below this the world reads as `ground`
    BlockState ground = Blocks.STONE.defaultBlockState();
    int surfaceY = 10000;                                     // heightmap answer (isInterior checks)
    final Set<String> unknown = new TreeSet<>();
    final ChunkAccess chunk = new DummyChunk();

    BlockState get(BlockPos p) {
      BlockState s = placed.get(p);
      if (s == null) s = world.get(p);
      if (s == null) s = p.getY() < groundY ? ground : Blocks.AIR.defaultBlockState();
      return s;
    }

    void set(BlockPos p0, BlockState s) {
      BlockPos p = p0.immutable();
      placed.put(p, s);
      bes.remove(p);
      if (s.hasBlockEntity() && s.getBlock() instanceof EntityBlock eb) {
        BlockEntity be = eb.newBlockEntity(p, s);
        if (be != null) bes.put(p, be);
      }
    }

    WorldGenLevel level() {
      InvocationHandler h = (proxy, method, a) -> {
        String n = method.getName();
        switch (n) {
          case "setBlock": case "setBlockAndUpdate": { set((BlockPos) a[0], (BlockState) a[1]); return true; }
          case "destroyBlock": case "removeBlock": { set((BlockPos) a[0], Blocks.AIR.defaultBlockState()); return true; }
          case "getBlockState": return get((BlockPos) a[0]);
          case "getFluidState": return get((BlockPos) a[0]).getFluidState();
          case "getBlockEntity": return bes.get(((BlockPos) a[0]).immutable());
          case "isEmptyBlock": return get((BlockPos) a[0]).isAir();
          case "getMinY": return -64;
          case "getMaxY": return 319;
          case "getSeaLevel": return 63;
          case "getChunk": return chunk;
          case "getHeight": return a == null || a.length == 0 ? 384 : surfaceY;
          case "isInsideBuildHeight": return true;
          case "getRandom": return new CannedRandom(0.9f);
          case "addFreshEntity": return true;
          case "toString": return "CaptureLevel";
          case "hashCode": return System.identityHashCode(proxy);
          case "equals": return proxy == a[0];
          default: {
            unknown.add(n);
            Class<?> r = method.getReturnType();
            if (r == boolean.class) return false;
            if (r == int.class) return 0;
            if (r == long.class) return 0L;
            if (r == float.class) return 0f;
            if (r == double.class) return 0d;
            return null;
          }
        }
      };
      return (WorldGenLevel) Proxy.newProxyInstance(WorldGenLevel.class.getClassLoader(), new Class<?>[]{ WorldGenLevel.class }, h);
    }
  }

  // ------------------------------------------------------------------- nbt

  @SuppressWarnings({"unchecked", "rawtypes"})
  static String pval(BlockState s, Property p) { return p.getName(s.getValue(p)); }

  static CompoundTag paletteEntry(BlockState s) {
    CompoundTag e = new CompoundTag();
    e.putString("Name", BuiltInRegistries.BLOCK.getKey(s.getBlock()).toString());
    if (!s.getProperties().isEmpty()) {
      CompoundTag props = new CompoundTag();
      for (Property<?> p : s.getProperties()) props.putString(p.getName(), pval(s, p));
      e.put("Properties", props);
    }
    return e;
  }

  // bb null: fit to the non-air extents of what was placed. northFlip: the
  // capture ran as an orientation-NORTH piece, so unflip z to authored space.
  static void write(String name, Capture cap, BoundingBox bb, boolean northFlip) throws Exception {
    if (bb == null) {
      int[] lo = { Integer.MAX_VALUE, Integer.MAX_VALUE, Integer.MAX_VALUE }, hi = { Integer.MIN_VALUE, Integer.MIN_VALUE, Integer.MIN_VALUE };
      for (Map.Entry<BlockPos, BlockState> e : cap.placed.entrySet()) {
        if (e.getValue().isAir()) continue;
        BlockPos p = e.getKey();
        lo[0] = Math.min(lo[0], p.getX()); lo[1] = Math.min(lo[1], p.getY()); lo[2] = Math.min(lo[2], p.getZ());
        hi[0] = Math.max(hi[0], p.getX()); hi[1] = Math.max(hi[1], p.getY()); hi[2] = Math.max(hi[2], p.getZ());
      }
      if (lo[0] > hi[0]) throw new IllegalStateException(name + ": nothing captured");
      bb = new BoundingBox(lo[0], lo[1], lo[2], hi[0], hi[1], hi[2]);
    }

    ListTag palette = new ListTag();
    Map<BlockState, Integer> palIdx = new LinkedHashMap<>();
    ListTag blocks = new ListTag();
    int skipped = 0;
    for (Map.Entry<BlockPos, BlockState> e : cap.placed.entrySet()) {
      BlockPos p = e.getKey();
      if (!bb.isInside(p)) { skipped++; continue; }
      BlockState s = e.getValue();
      Integer idx = palIdx.get(s);
      if (idx == null) { idx = palette.size(); palIdx.put(s, idx); palette.add(paletteEntry(s)); }
      int lx = p.getX() - bb.minX(), ly = p.getY() - bb.minY();
      int lz = northFlip ? bb.maxZ() - p.getZ() : p.getZ() - bb.minZ();
      CompoundTag b = new CompoundTag();
      b.putInt("state", idx);
      b.put("pos", intList(lx, ly, lz));
      BlockEntity be = cap.bes.get(p);
      if (be != null) {
        CompoundTag t = be.saveWithoutMetadata(REGS);
        t.putString("id", BuiltInRegistries.BLOCK_ENTITY_TYPE.getKey(be.getType()).toString());
        b.put("nbt", t);
      }
      blocks.add(b);
    }

    ListTag entities = new ListTag();
    for (CompoundTag nbt : cap.entities) {
      // entity positions arrive world-space, shift/flip like blocks
      ListTag pos = nbt.getListOrEmpty("pos");
      double ex = pos.getDoubleOr(0, 0) - bb.minX(), ey = pos.getDoubleOr(1, 0) - bb.minY();
      double ez = northFlip ? bb.maxZ() + 1 - (pos.getDoubleOr(2, 0)) : pos.getDoubleOr(2, 0) - bb.minZ();
      CompoundTag e = new CompoundTag();
      ListTag dp = new ListTag();
      dp.add(DoubleTag.valueOf(ex)); dp.add(DoubleTag.valueOf(ey)); dp.add(DoubleTag.valueOf(ez));
      e.put("pos", dp);
      e.put("blockPos", intList((int) Math.floor(ex), (int) Math.floor(ey), (int) Math.floor(ez)));
      e.put("nbt", nbt.getCompoundOrEmpty("nbt"));
      entities.add(e);
    }

    CompoundTag root = new CompoundTag();
    root.put("size", intList(bb.getXSpan(), bb.getYSpan(), bb.getZSpan()));
    root.put("palette", palette);
    root.put("blocks", blocks);
    root.put("entities", entities);
    root.putInt("DataVersion", SharedConstants.getCurrentVersion().dataVersion().version());

    Path file = OUT.resolve("data/minecraft/structure/builtin/" + name + ".nbt");
    Files.createDirectories(file.getParent());
    NbtIo.writeCompressed(root, file);
    System.out.println("[builtin] " + name + ": " + blocks.size() + " blocks, " + bb.getXSpan() + "x" + bb.getYSpan() + "x" + bb.getZSpan()
      + (skipped > 0 ? " (" + skipped + " outside bb)" : "")
      + (cap.unknown.isEmpty() ? "" : " unknown level calls: " + cap.unknown));
  }

  static ListTag intList(int... vs) {
    ListTag l = new ListTag();
    for (int v : vs) l.add(IntTag.valueOf(v));
    return l;
  }

  static HolderLookup.Provider worldLookup() {
    for (String name : new String[]{ "createWorldLookup", "createLookup" }) {
      try { return (HolderLookup.Provider) VanillaRegistries.class.getMethod(name).invoke(null); }
      catch (NoSuchMethodException e) { continue; }
      catch (Exception e) { throw new RuntimeException(e); }
    }
    throw new RuntimeException("no VanillaRegistries world-lookup factory found");
  }

  // ------------------------------------------------------------- structures

  static void endPlatform() throws Exception {
    Capture cap = new Capture();
    EndPlatformFeature.createEndPlatform(cap.level(), new BlockPos(0, 0, 0), false);
    write("end_platform", cap, null, false);
  }

  static void endGateway() throws Exception {
    Capture cap = new Capture();
    new EndGatewayFeature(Optional.empty(), false).place(cap.level(), null, new CannedRandom(0.9f), new BlockPos(0, 0, 0));
    write("end_gateway", cap, null, false);
  }

  static void exitPortal(boolean active) throws Exception {
    Capture cap = new Capture();
    new EndPodiumFeature(active).place(cap.level(), null, new CannedRandom(0.9f), new BlockPos(0, 0, 0));
    write(active ? "exit_portal_active" : "exit_portal", cap, null, false);
  }

  public static void main(String[] args) throws Exception {
    SharedConstants.tryDetectVersion();
    Bootstrap.bootStrap();
    REGS = worldLookup();
    OUT = Path.of(args[0]);

    endPlatform();
    endGateway();
    exitPortal(false);
    exitPortal(true);
    System.out.println("[builtin] done");
  }
}
